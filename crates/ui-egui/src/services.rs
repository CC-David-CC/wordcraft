/// Platform services injected by the host. Files, the clipboard, animations and preferences
/// reach the app through the framework's host, not through here.
#[derive(Default)]
pub struct Services {
    /// Web: ask the browser for fresh clipboard contents after a Paste command.
    #[cfg(target_arch = "wasm32")]
    pub read_browser_clipboard: Option<BrowserClipboardReader>,
    /// Desktop printer jobs through the host.
    pub print: Option<craft::print::spool::Spool>,
    /// Browser print submission with the result of the PDF frame's load and print call.
    pub print_async: Option<crate::printing::BrowserSubmit>,
    /// Web: told whether the document has unsaved changes after each pass, for the browser's
    /// leave-page guard (`beforeunload` runs between frames and can't ask the app).
    pub on_dirty: Option<Box<dyn Fn(bool)>>,
    /// Explicit document metadata for a host's lifecycle/recovery coordinator.
    /// Never contains document bytes or platform authentication credentials.
    pub on_document_state: Option<Box<dyn Fn(&HostDocumentState)>>,
    /// Opt-in external document-window ownership. Interactive New/Open/Close
    /// ask the host, keeping the current native document and its undo intact.
    pub host_document: Option<HostDocumentFn>,
    /// Write hosted bytes with the originating document and revision.
    pub host_save: Option<HostSaveFn>,
    /// Web: keep a font the user added (stored file name, original bytes) for the next visit
    /// (#582). Desktop fonts are stored by the font database itself, in the app's font folder.
    pub store_font: Option<Box<dyn Fn(&str, &[u8])>>,
    /// Web: forget a stored font (its stored file name) once the user removes it.
    pub forget_font: Option<Box<dyn Fn(&str)>>,
    /// Web: request browser to query and load local installed fonts (`window.queryLocalFonts()`).
    pub load_system_fonts: Option<Box<dyn Fn()>>,
    /// Desktop: File › Options › General › Make WordCraft the default for Word documents (#295),
    /// only from that button (never a programmatic command). Windows opens the Settings app's
    /// Default apps page (apps can't set defaults themselves); Linux and BSD set it with
    /// `xdg-mime`. `None` (web, macOS) hides the button; macOS shows how to do it in Finder
    /// instead. An error means nothing changed.
    #[cfg(not(target_arch = "wasm32"))]
    pub make_default_app: Option<Box<dyn Fn() -> Result<craft::platform::default_app::DefaultApp, craft::platform::default_app::DefaultAppError>>>,
    /// Desktop: the app's own user templates folder (`Templates` in the settings folder, #2852),
    /// used while File › Options names none. File › New lists personal templates from it and Save
    /// as Word Template starts in it. `None` (web) hides personal templates.
    pub templates_dir: Option<std::path::PathBuf>,
    /// Files the system asked the app to open, and files dropped on a window, read once per frame.
    pub intake: Option<craft::platform::open::FileIntake>,
}

#[cfg(target_arch = "wasm32")]
pub type BrowserClipboardReader = Box<dyn Fn(bool) -> std::sync::mpsc::Receiver<Result<serde_json::Value, String>>>;

pub struct HostSaveContext {
    /// Exact live document that produced these bytes, captured before host dispatch.
    pub document: u64,
    pub revision: u64,
    pub operation: String,
    /// This save format becomes the live document source; exports remain copies.
    pub document_save: bool,
    /// Exact path requested by the command, before the transport takes its leaf.
    pub path: String,
}

pub type HostSaveFn = Box<dyn Fn(&str, &[u8], bool, &HostSaveContext) -> Result<craft::host::PickId, String>>;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDocumentState {
    pub active: String,
    pub documents: Vec<HostDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDocument {
    pub id: String,
    pub revision: String,
    pub dirty: bool,
    pub pending_saves: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDocumentRequest {
    pub document: String,
    pub revision: String,
    pub command: String,
    pub params: serde_json::Value,
}
pub type HostDocumentFn = Box<dyn Fn(&HostDocumentRequest) -> Result<(), String>>;
