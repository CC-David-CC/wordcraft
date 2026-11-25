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

use std::cell::RefCell;
use std::rc::Rc;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use craft::host::{FileError, Files, PickId, PickRequest, Picked};
use craft::platform::browser_files::BrowserFiles;
use craft::platform::open::{DropTarget, DroppedFile, IntakeSender};
use craft::web_host::{Mode, web::{FileData, Host, Message}};
use wasm_bindgen::{JsCast as _, JsValue, closure::Closure};
use wordcraft_ui_egui::{HostSaveContext, Services, WordApp};

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
    pub fn connect(&self, services: &mut Services, intake: IntakeSender, ctx: egui::Context, files: Arc<HostedFiles>) {
        let document_host = web_sys::window()
            .and_then(|w| w.location().search().ok())
            .is_some_and(|search| search.trim_start_matches('?').split('&').any(|part| part == "documentHost=1"));
        self.listen(intake, ctx.clone(), files.clone());
        self.listen_results(ctx.clone(), files.clone());
        let bridge = self.clone();
        services.host_save = Some(Box::new(move |name, bytes, save_as, context| {
            bridge.post_save(name, bytes, save_as, context, document_host, &files, &ctx)
        }));
        // The crate does not repeat a state it already reported.
        let host = self.host.clone();
        services.on_dirty = Some(Box::new(move |dirty: bool| host.post_dirty(dirty)));
        // External document-window ownership is opt-in; other embeddings keep
        // their existing native file picker and window behavior.
        if document_host {
            let bridge = self.clone();
            services.host_document = Some(Box::new(move |request| {
                let encoded = serde_json::to_string(request).map_err(|_| "Could not encode document request")?;
                let value = js_sys::JSON::parse(&encoded).map_err(|_| "Could not encode document request")?;
                bridge.post_document_event("request", &value)
            }));
        }
        // Metadata changes on every native revision, rather than only when the
        // dirty boolean flips. Hosts can debounce rich checkpoints outside typing.
        let bridge = self.clone();
        let previous = RefCell::new(None);
        services.on_document_state = Some(Box::new(move |state| {
            if previous.borrow().as_ref() == Some(state) {
                return;
            }
            if let Ok(encoded) = serde_json::to_string(state)
                && let Ok(value) = js_sys::JSON::parse(&encoded)
                && bridge.post_document_event("state", &value).is_ok()
            {
                *previous.borrow_mut() = Some(state.clone());
            }
        }));
    }

    fn post_document_event(&self, kind: &str, value: &JsValue) -> Result<(), String> {
        let event_type = format!("wordcraft:document-{kind}");
        if self.host.mode() == Mode::Parent {
            js_sys::Reflect::set(value, &"type".into(), &event_type.into()).map_err(|_| "Could not encode document state")?;
            let window = web_sys::window().ok_or("Host page unavailable")?;
            let parent = window.parent().map_err(|_| "Host page unavailable")?.ok_or("Host page unavailable")?;
            let origin = window.location().origin().map_err(|_| "Host origin unavailable")?;
            parent.post_message(value, &origin).map_err(|_| "Could not send document state".into())
        } else {
            let init = web_sys::CustomEventInit::new();
            init.set_detail(value);
            let event = web_sys::CustomEvent::new_with_event_init_dict(&event_type, &init).map_err(|_| "Could not encode document state")?;
            self.canvas.dispatch_event(&event).map(|_| ()).map_err(|_| "Could not send document state".into())
        }
    }

    /// `?author=`: the host's name for the user signs comments and tracked changes.
    pub fn set_author(app: &mut WordApp, author: &str) {
        let author: String = author.trim().chars().take(MAX_AUTHOR_CHARS).collect();
        if !author.is_empty() {
            app.set_host_author(author);
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
        &self, path: &str, bytes: &[u8], save_as: bool, context: &HostSaveContext, document_host: bool,
        files: &Arc<HostedFiles>, ctx: &egui::Context,
    ) -> Result<PickId, String> {
        let window = web_sys::window().ok_or_else(|| "The host page is gone".to_string())?;
        let name = Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or(path);
        let ticket = files.reserve(name, context.document_save, document_host && context.document_save)?;
        let id = format!("wordcraft-save-{}", ticket.0);
        if let Err(error) = self.post_identified_save(name, bytes, &id, save_as, context) {
            files.forget(ticket);
            return Err(error);
        }
        let (pending, repaint) = (files.clone(), ctx.clone());
        let timeout = Closure::once_into_js(move || {
            pending.finish(ticket, Picked::Failed(
                "Save confirmation did not arrive. It may have completed; check the account file before retrying.".into()
            ));
            repaint.request_repaint();
        });
        if window.set_timeout_with_callback_and_timeout_and_arguments_0(timeout.unchecked_ref(), 120_000).is_err() {
            files.finish(ticket, Picked::Failed("Save was sent but its confirmation timer failed; check the account file before retrying.".into()));
        }
        Ok(ticket)
    }

    /// Add document/revision identity at the real serialization boundary. The generic
    /// bridge's opaque save id/ack stays compatible; this fork adds explicit target fields.
    fn post_identified_save(
        &self,
        name: &str,
        bytes: &[u8],
        id: &str,
        save_as: bool,
        context: &HostSaveContext,
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
        set("documentId", context.document.to_string().into())?;
        set("revision", context.revision.to_string().into())?;
        set("operation", context.operation.as_str().into())?;
        set("documentSave", context.document_save.into())?;
        set("path", context.path.as_str().into())?;
        if self.host.mode() == Mode::Parent {
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

    /// Account writes reply with a canonical path or an explicit failure.
    fn listen_results(&self, ctx: egui::Context, files: Arc<HostedFiles>) {
        let deliver = Rc::new(move |kind: &str, data: JsValue| {
            let read = |key: &str| js_sys::Reflect::get(&data, &JsValue::from_str(key)).ok().and_then(|v| v.as_string());
            let Some(ticket) = read("id").as_deref().and_then(save_ticket) else { return };
            if kind == "wordcraft:save-result" {
                files.accept(ticket, read("path").filter(|path| valid_source_path(path)).map(PathBuf::from));
            } else {
                let error = read("error").unwrap_or_else(|| "The host could not confirm this save.".into());
                files.finish(ticket, Picked::Failed(error.chars().take(1024).collect()));
            }
            ctx.request_repaint();
        });
        if self.host.mode() == Mode::Parent {
            let Some(window) = web_sys::window() else { return };
            let Some(parent) = window.parent().ok().flatten() else { return };
            let Ok(origin) = window.location().origin() else { return };
            let listener = Closure::<dyn Fn(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
                if event.origin() != origin || !event.source().is_some_and(|source| js_sys::Object::is(&source, &parent)) {
                    return;
                }
                let data = event.data();
                if let Some(kind) = js_sys::Reflect::get(&data, &JsValue::from_str("type")).ok().and_then(|v| v.as_string())
                    && matches!(kind.as_str(), "wordcraft:save-failed" | "wordcraft:save-result")
                {
                    deliver(&kind, data);
                }
            });
            if window.add_event_listener_with_callback("message", listener.as_ref().unchecked_ref()).is_ok() {
                listener.forget();
            }
        } else {
            for kind in ["wordcraft:save-failed", "wordcraft:save-result"] {
                let deliver = deliver.clone();
                let listener = Closure::<dyn Fn(web_sys::CustomEvent)>::new(move |event: web_sys::CustomEvent| deliver(kind, event.detail()));
                if self.canvas.add_event_listener_with_callback(kind, listener.as_ref().unchecked_ref()).is_ok() {
                    listener.forget();
                }
            }
        }
    }

    fn listen(&self, intake: IntakeSender, ctx: egui::Context, files: Arc<HostedFiles>) {
        self.host.listen(move |message| match message {
            Message::Open { name, data } => deliver_open(&intake, &name, &data),
            Message::Saved { id } => {
                if let Some(ticket) = save_ticket(&id) {
                    files.accept(ticket, None);
                    ctx.request_repaint();
                }
            }
            _ => {}
        });
    }
}

fn save_ticket(id: &str) -> Option<PickId> {
    id.strip_prefix("wordcraft-save-")?.parse().ok().map(PickId)
}

fn valid_source_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 2048
        && !path.starts_with('/')
        && !path.ends_with('/')
        && !path.split('/').any(|part| part.is_empty() || matches!(part, "." | "..") || part.chars().any(|c| c.is_control() || c == '\\'))
}

/// The file an open message carries, queued for the next frame like a dropped file. A host's file
/// is untrusted input: an oversized one is refused before it is copied into the app's memory (the
/// data's own length, not the host's claim). The crate has cleaned the name (and cut it to 255
/// characters); a blank one comes as `document` and becomes `Document.docx`.
fn deliver_open(intake: &IntakeSender, name: &str, data: &FileData) {
    let name = if name == "document" { DEFAULT_NAME } else { name }.to_string();
    let FileData::Bytes(array) = data else {
        log::warn!("host file {name} came as a File; WordCraft reads bytes only; not opened");
        return;
    };
    if data.size() > MAX_OPEN_BYTES as f64 {
        log::warn!("host file is {} bytes, over the {} MiB host open limit; not opened", data.size(), MAX_OPEN_BYTES >> 20);
        return;
    }
    let file = DroppedFile { path: None, name, bytes: Some(Arc::from(array.to_vec())) };
    intake.dropped(vec![file], DropTarget::Elsewhere);
}

/// A pending write and the acknowledgement needed to release it.
struct SaveReply {
    name: String,
    document_save: bool,
    canonical: bool,
    result: Option<Picked>,
}

pub struct HostedFiles {
    inner: Arc<BrowserFiles>,
    replies: Mutex<HashMap<u64, SaveReply>>,
}

impl HostedFiles {
    pub fn new(inner: Arc<BrowserFiles>) -> Self {
        Self { inner, replies: Mutex::new(HashMap::new()) }
    }

    fn reserve(&self, name: &str, document_save: bool, canonical: bool) -> Result<PickId, String> {
        let mut replies = self.replies.lock().unwrap_or_else(|e| e.into_inner());
        if replies.len() >= 8 {
            return Err("Too many unconfirmed host saves; wait for their results.".into());
        }
        // Like the framework's hosted adapter, reserve an ID without opening a picker.
        let ticket = self.inner.pick(PickRequest::folder("hosted-save"));
        self.inner.forget(ticket);
        replies.insert(ticket.0, SaveReply { name: name.into(), document_save, canonical, result: None });
        Ok(ticket)
    }

    fn finish(&self, id: PickId, result: Picked) {
        let mut replies = self.replies.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(reply) = replies.get_mut(&id.0)
            && reply.result.is_none()
        {
            reply.result = Some(result);
        }
    }

    fn accept(&self, id: PickId, path: Option<PathBuf>) {
        let mut replies = self.replies.lock().unwrap_or_else(|e| e.into_inner());
        let Some(reply) = replies.get_mut(&id.0).filter(|r| r.result.is_none()) else { return };
        reply.result = Some(if !reply.document_save {
            Picked::Downloaded(reply.name.clone())
        } else if let Some(path) = path {
            Picked::Paths(vec![path])
        } else if reply.canonical {
            Picked::Failed("Host save result has no canonical source path.".into())
        } else {
            Picked::Paths(vec![PathBuf::from(&reply.name)])
        });
    }
}

impl Files for HostedFiles {
    fn pick(&self, request: PickRequest) -> PickId {
        self.inner.pick(request)
    }

    fn take_answer(&self, id: PickId) -> Option<Picked> {
        let mut replies = self.replies.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(reply) = replies.get_mut(&id.0) {
            let answer = reply.result.take()?;
            replies.remove(&id.0);
            return Some(answer);
        }
        self.inner.take_answer(id)
    }

    fn forget(&self, id: PickId) {
        if self.replies.lock().unwrap_or_else(|e| e.into_inner()).remove(&id.0).is_none() {
            self.inner.forget(id);
        }
    }

    fn pick_pending(&self) -> bool {
        self.inner.pick_pending()
    }

    fn read(&self, path: &Path) -> Result<Vec<u8>, FileError> {
        self.inner.read(path)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> Result<(), FileError> {
        self.inner.write(path, bytes)
    }

    fn last_folder(&self, purpose: &str) -> Option<PathBuf> {
        self.inner.last_folder(purpose)
    }

    fn save(&self, _request: PickRequest, _bytes: Vec<u8>) -> PickId {
        // Hosted writes require the document identity supplied through Services::host_save.
        // BrowserFiles answers folder requests with Unavailable without presenting a picker.
        self.inner.pick(PickRequest::folder("hosted-save"))
    }

    fn can_pick(&self) -> bool {
        false
    }

    fn browser_saves(&self) -> bool {
        true
    }
}
