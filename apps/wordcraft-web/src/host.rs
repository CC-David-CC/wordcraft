//! Host modes: a page that runs WordCraft (as an `<iframe>`, or in its own document) opens
//! documents in it and stores what it saves instead of the browser downloading. The messages and
//! the two transports are `craft-web-host`'s (storytold/craft-libs), the same contract as the
//! other Craft apps' bridges, with the `wordcraft:` prefix. This module is WordCraft's part of it.
//!
//! - `?host=parent` (an `<iframe>`, such as a Nextcloud app) talks to the same-origin parent over
//!   `postMessage`; `data-host="page"` on the canvas (the page's own document, no iframe) uses
//!   DOM `CustomEvent`s on the canvas instead. `?host=parent` wins when both are present. With no
//!   parent, or a parent on another origin, there is no bridge: the normal app with downloads.
//! - `wordcraft:ready` once the app is running and listening; send a file now. WordCraft reads
//!   bytes, so it says `file: false` and a host sends `bytes`.
//! - `wordcraft:open` (from the host): `{ name, bytes }`. It opens like a document picked with
//!   File › Open or dropped on the window; a file over [`MAX_OPEN_BYTES`] is refused before it is
//!   copied.
//! - `wordcraft:save` (to the host): `{ name, saveAs, bytes }` for every file WordCraft would
//!   otherwise download, with an `id`. The host sends `wordcraft:saved {id}` only after durable
//!   success, or `wordcraft:save-failed {id,error}` for refusal/uncertainty. Silence times out
//!   without marking the document saved. `saveAs` says whether
//!   the file becomes the document's file:
//!   - Save: `false`. It writes the opened file under its own name and format, as the desktop
//!     app does. A name the parent never sent (an untitled document, an imported .doc saved as
//!     .docx) is a new file: `true`, as for Save As.
//!   - Save As, and File › Export to another document format (which runs Save As): `true` for a
//!     format that keeps everything (.docx and the other Word packages, .odt, .rtf). The document
//!     is now that file; the next Save sends its name with `false`.
//!   - Save As or Export to a format that doesn't (PDF, Markdown, plain text), Export as PDF and
//!     Export Page as PNG: `false`. They are copies; the document's file stays the same.
//! - `wordcraft:dirty` whenever unsaved changes appear or go away, `wordcraft:failed` when the
//!   app couldn't start.
//!
//! In both host modes the host sends the document to edit, so no sample opens, saves are handed
//! to the host rather than downloaded, the host guards leaving the page, and `?author=` names the
//! user for comments and tracked changes.

use std::rc::Rc;

use craft_web_host::web::{FileData, Host, Message};
use wasm_bindgen::{JsCast as _, JsValue, closure::Closure};
use wordcraft_ui_egui::async_saves::{AsyncSaves, SaveOutcome};
use wordcraft_ui_egui::{Inbox, Services, WordApp};

/// The app id in the host messages (`wordcraft:ready`).
const APP: &str = "wordcraft";

/// The name a document gets when the host sent none (the crate says `document` for a blank name).
const DEFAULT_NAME: &str = "Document.docx";

/// The largest document taken from the host page, refused before it is copied.
const MAX_OPEN_BYTES: u64 = 512 << 20;

/// The longest user name taken from `?author=`.
const MAX_AUTHOR_CHARS: usize = 200;

#[derive(Clone)]
pub struct Bridge {
    host: Rc<Host>,
    canvas: web_sys::EventTarget,
}

impl Bridge {
    /// The bridge for this page, or `None` when WordCraft isn't hosted: no `?host=parent` and no
    /// `data-host="page"` on the canvas, an unframed `?host=parent` page (it stays the normal app
    /// with downloads), or a parent on another origin.
    pub fn detect(canvas: &web_sys::HtmlCanvasElement) -> Option<Self> {
        Some(Self { host: Rc::new(Host::connect(APP, canvas)?), canvas: canvas.clone().into() })
    }

    /// Hand saved and exported files to the host instead of downloading them, report unsaved
    /// changes to it, and hear the files it sends.
    pub fn connect(&self, services: &mut Services, inbox: Inbox, ctx: egui::Context) {
        let saves = services.async_saves.clone().unwrap_or_default();
        self.listen(inbox, ctx.clone(), saves.clone());
        self.listen_failures(ctx.clone(), saves.clone());
        let (bridge, pending, repaint) = (self.clone(), saves.clone(), ctx.clone());
        services.host_save = Some(Box::new(move |name: &str, bytes: &[u8], save_as: bool, context: &wordcraft_ui_egui::HostSaveContext| {
            bridge.post_save(name, bytes, save_as, Some(context), &pending, &repaint)
        }));
        // Exports also require a result, but do not become the document's source.
        let (bridge, pending, repaint) = (self.clone(), saves.clone(), ctx);
        services.download = Some(Box::new(move |name: &str, bytes: &[u8]| bridge.post_save(name, bytes, false, None, &pending, &repaint)));
        services.async_saves = Some(saves);
        // The crate does not repeat a state it already reported.
        let host = self.host.clone();
        services.on_dirty = Some(Box::new(move |dirty: bool| host.post_dirty(dirty)));
    }

    /// `?author=`: the host's name for the user signs comments and tracked changes.
    pub fn set_author(app: &mut WordApp, author: &str) {
        let author: String = author.trim().chars().take(MAX_AUTHOR_CHARS).collect();
        if !author.is_empty() {
            app.session.author = author;
        }
    }

    pub fn post_ready(&self) {
        let _ = self.host.post_ready(env!("CARGO_PKG_VERSION"), false);
    }

    /// The app couldn't start (no WebGPU or WebGL2, for example): let the host say so.
    pub fn post_failed(&self, error: &str) {
        let _ = self.host.post_failed(error, None);
    }

    fn post_save(
        &self,
        path: &str,
        bytes: &[u8],
        save_as: bool,
        context: Option<&wordcraft_ui_egui::HostSaveContext>,
        saves: &AsyncSaves,
        ctx: &egui::Context,
    ) -> Result<(), String> {
        if saves.pending() >= 8 {
            return Err("Too many unconfirmed host saves; wait for their results.".into());
        }
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        let ticket = saves.start();
        let id = format!("wordcraft-save-{ticket}");
        if let Err(error) = self.post_identified_save(&name, bytes, &id, save_as, context) {
            saves.finish(ticket, SaveOutcome::Failed(error.clone()));
            return Err(error);
        }
        // Silence is not success. Timeout retains unsaved work and reports uncertainty;
        // a host must never blindly retry a mutation whose reply was lost.
        let (pending, repaint) = (saves.clone(), ctx.clone());
        let timeout = Closure::once_into_js(move || {
            pending.finish(
                ticket,
                SaveOutcome::Failed("Save confirmation did not arrive. It may have completed; check the account file before retrying.".into()),
            );
            repaint.request_repaint();
        });
        let scheduled = web_sys::window()
            .ok_or_else(|| "The host page is gone".to_string())?
            .set_timeout_with_callback_and_timeout_and_arguments_0(timeout.unchecked_ref(), 120_000);
        if scheduled.is_err() {
            saves.finish(
                ticket,
                SaveOutcome::Failed("Save was sent but its confirmation timer failed; check the account file before retrying.".into()),
            );
            return Err("Save outcome is unknown; confirmation timer unavailable.".into());
        }
        Ok(())
    }

    /// Add document/revision identity at the real serialization boundary. The generic
    /// bridge's opaque save id/ack stays compatible; this fork adds explicit target fields.
    fn post_identified_save(
        &self,
        name: &str,
        bytes: &[u8],
        id: &str,
        save_as: bool,
        context: Option<&wordcraft_ui_egui::HostSaveContext>,
    ) -> Result<(), String> {
        let value = js_sys::Object::new();
        let buffer = js_sys::Uint8Array::from(bytes).buffer();
        let set = |key: &str, field: JsValue| {
            js_sys::Reflect::set(&value, &JsValue::from_str(key), &field).map(|_| ()).map_err(|_| "Could not encode host save".to_string())
        };
        set("name", name.into())?;
        set("bytes", buffer.clone().into())?;
        set("id", id.into())?;
        set("saveAs", save_as.into())?;
        if let Some(context) = context {
            set("documentId", context.document.to_string().into())?;
            set("revision", context.revision.to_string().into())?;
            set("operation", context.operation.as_str().into())?;
            set("documentSave", context.document_save.into())?;
        }
        if self.host.mode() == craft_web_host::Mode::Parent {
            set("type", "wordcraft:save".into())?;
            let window = web_sys::window().ok_or_else(|| "Host page unavailable".to_string())?;
            let parent = window.parent().map_err(|_| "Host page unavailable".to_string())?.ok_or_else(|| "Host page unavailable".to_string())?;
            let origin = window.location().origin().map_err(|_| "Host origin unavailable".to_string())?;
            parent.post_message_with_transfer(&value, &origin, &js_sys::Array::of1(&buffer)).map_err(|_| "Could not send host save".to_string())
        } else {
            let init = web_sys::CustomEventInit::new();
            init.set_detail(&value);
            let event =
                web_sys::CustomEvent::new_with_event_init_dict("wordcraft:save", &init).map_err(|_| "Could not send host save".to_string())?;
            self.canvas.dispatch_event(&event).map(|_| ()).map_err(|_| "Could not send host save".to_string())
        }
    }

    /// The base bridge has a positive acknowledgement. This explicit extension reports
    /// failed/cancelled/uncertain storage without waiting for the timeout. The same
    /// origin/source checks as the base parent transport apply; page mode uses its canvas.
    fn listen_failures(&self, ctx: egui::Context, saves: AsyncSaves) {
        let deliver = Rc::new(move |data: JsValue| {
            let read = |key: &str| js_sys::Reflect::get(&data, &JsValue::from_str(key)).ok().and_then(|v| v.as_string());
            let Some(ticket) = read("id").as_deref().and_then(save_ticket) else { return };
            let error = read("error").unwrap_or_else(|| "The host could not confirm this save.".into());
            let error: String = error.chars().take(1024).collect();
            saves.finish(ticket, SaveOutcome::Failed(error));
            ctx.request_repaint();
        });
        if self.host.mode() == craft_web_host::Mode::Parent {
            let Some(window) = web_sys::window() else { return };
            let Some(parent) = window.parent().ok().flatten() else { return };
            let Ok(origin) = window.location().origin() else { return };
            let listener = Closure::<dyn Fn(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
                if event.origin() != origin || !event.source().is_some_and(|source| js_sys::Object::is(&source, &parent)) {
                    return;
                }
                let data = event.data();
                if js_sys::Reflect::get(&data, &JsValue::from_str("type")).ok().and_then(|v| v.as_string()).as_deref()
                    == Some("wordcraft:save-failed")
                {
                    deliver(data);
                }
            });
            if window.add_event_listener_with_callback("message", listener.as_ref().unchecked_ref()).is_ok() {
                listener.forget();
            }
        } else {
            let listener = Closure::<dyn Fn(web_sys::CustomEvent)>::new(move |event: web_sys::CustomEvent| deliver(event.detail()));
            if self.canvas.add_event_listener_with_callback("wordcraft:save-failed", listener.as_ref().unchecked_ref()).is_ok() {
                listener.forget();
            }
        }
    }

    /// Hear `wordcraft:open` and queue the file like a dropped one.
    fn listen(&self, inbox: Inbox, ctx: egui::Context, saves: AsyncSaves) {
        self.host.listen(move |message| match message {
            Message::Open { name, data } => deliver_open(&inbox, &ctx, &name, &data),
            Message::Saved { id } => {
                if let Some(ticket) = save_ticket(&id) {
                    saves.finish(ticket, SaveOutcome::Saved);
                    ctx.request_repaint();
                }
            }
            _ => {}
        });
    }
}

fn save_ticket(id: &str) -> Option<u64> {
    id.strip_prefix("wordcraft-save-")?.parse().ok()
}

/// The file an open message carries, pushed onto the inbox for the next frame, like a dropped
/// file. A host's file is untrusted input: an oversized one is refused before it is copied into
/// the app's memory (the data's own length, not the host's claim). The crate has cleaned the name
/// (and cut it to 255 characters); a blank one comes as `document` and becomes `Document.docx`.
fn deliver_open(inbox: &Inbox, ctx: &egui::Context, name: &str, data: &FileData) {
    let name = if name == "document" { DEFAULT_NAME } else { name }.to_string();
    let FileData::Bytes(array) = data else {
        log::warn!("host file {name} came as a File; WordCraft reads bytes only; not opened");
        return;
    };
    if data.size() > MAX_OPEN_BYTES as f64 {
        log::warn!("host file is {} bytes, over the {} MiB host open limit; not opened", data.size(), MAX_OPEN_BYTES >> 20);
        return;
    }
    inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, array.to_vec()));
    ctx.request_repaint();
}
