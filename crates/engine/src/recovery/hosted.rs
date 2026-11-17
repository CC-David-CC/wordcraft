//! Explicit rich-document checkpoints for an external host. No filesystem I/O,
//! credentials or saved-state acknowledgement; the host owns storage and scope.
use std::io::Write;

use serde_json::{Value, json};

use crate::{CmdError, CmdResult, Session, p};

const MAX_BYTES: usize = 128 << 20;
const VERSION: u64 = 1;

struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("Document recovery exceeds 128 MiB"));
        }
        self.0.try_reserve(bytes.len()).map_err(std::io::Error::other)?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn snapshot(s: &mut Session, _: &Value) -> CmdResult {
    // Match native recovery: do not turn a password-protected document into a
    // plaintext checkpoint or include its password in a host response.
    if s.password.is_some() {
        return Err(CmdError::Params("Local recovery is unavailable for password-protected documents; save the document.".into()));
    }
    let mut encoded = Bounded(Vec::new());
    serde_json::to_writer(&mut encoded, &s.doc).map_err(|e| CmdError::Params(e.to_string()))?;
    let data = String::from_utf8(encoded.0).map_err(|e| CmdError::Params(e.to_string()))?;
    Ok(json!({"version": VERSION, "data": data, "revision": s.rev().to_string()}))
}

pub(crate) fn restore_snapshot(s: &mut Session, v: &Value) -> CmdResult {
    if v.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return Err(CmdError::Params("Unsupported document recovery version".into()));
    }
    let expected = p::req_str(v, "expectedRevision")?.parse::<u64>().map_err(|_| CmdError::Params("Invalid recovery target revision".into()))?;
    if s.rev() != expected || s.dirty {
        return Err(CmdError::Params("Recovery target changed; keep the existing document open.".into()));
    }
    let data = p::req_str(v, "data")?;
    if data.len() > MAX_BYTES {
        return Err(CmdError::Params("Document recovery exceeds 128 MiB".into()));
    }
    let source_path = match v.get("sourcePath") {
        None | Some(Value::Null) => None,
        Some(Value::String(path))
            if !path.is_empty()
                && path.len() <= 2048
                && !path.starts_with('/')
                && !path.ends_with('/')
                && !path.split('/').any(|part| {
                    part.is_empty() || part.len() > 255 || part.starts_with('.') || part.chars().any(|c| c.is_control() || c == '\\')
                }) =>
        {
            Some(std::path::PathBuf::from(path))
        }
        _ => return Err(CmdError::Params("A recovery source must be a canonical relative file path".into())),
    };
    let document = serde_json::from_str(data).map_err(|e| CmdError::Params(format!("Invalid document recovery: {e}")))?;
    s.set_document(document);
    s.path = source_path;
    s.dirty = true;
    Ok(json!({"id":s.document_id(), "revision":s.rev().to_string(), "recovered":true, "saved":false}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session::new(wordcraft_doc::Document::new())
    }

    #[test]
    fn rich_checkpoint_round_trip_is_not_a_save_or_plain_text_export() {
        let mut source = session();
        source.run("file.new", &json!({"template":"sample"})).unwrap();
        source.run("para.heading1", &json!({})).unwrap();
        source.run("text.insert", &json!({"text":"Recovery heading"})).unwrap();
        let before = serde_json::to_value(&source.doc).unwrap();
        let captured = source.run("document.recoverySnapshot", &json!({})).unwrap();
        assert!(source.dirty);
        // Float fields retain their native f32 type. Comparing an untyped
        // parsed JSON number against Value::from(f32) instead would compare the
        // shortest textual spelling with a promoted f64, not document fidelity.
        let decoded: wordcraft_doc::Document = serde_json::from_str(captured["data"].as_str().unwrap()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), before);
        let mut target = session();
        let result = target
            .run(
                "document.restoreSnapshot",
                &json!({
                    "version":captured["version"],"data":captured["data"],"expectedRevision":target.rev().to_string(),"sourcePath":"Documents/Folder/Recovered.docx"
                }),
            )
            .unwrap();
        assert_eq!(result["saved"], false);
        assert!(target.dirty);
        assert_eq!(target.path.as_deref(), Some(std::path::Path::new("Documents/Folder/Recovered.docx")));
        assert_eq!(serde_json::to_value(&target.doc).unwrap(), before);
    }

    #[test]
    fn recovery_refuses_stale_or_dirty_targets_without_replacing_work() {
        let mut s = session();
        let captured = s.run("document.recoverySnapshot", &json!({})).unwrap();
        let stale = s.rev().to_string();
        s.run("text.insert", &json!({"text":"Keep this work"})).unwrap();
        let before = serde_json::to_value(&s.doc).unwrap();
        for revision in [stale, s.rev().to_string()] {
            assert!(s.run("document.restoreSnapshot", &json!({"version":1,"data":captured["data"],"expectedRevision":revision})).is_err());
            assert_eq!(serde_json::to_value(&s.doc).unwrap(), before);
        }
    }

    #[test]
    fn invalid_recovery_is_transactional_and_never_accepts_a_path() {
        let mut s = session();
        let captured = s.run("document.recoverySnapshot", &json!({})).unwrap();
        let id = s.document_id();
        for (version, data, name) in
            [(2, captured["data"].clone(), json!(null)), (1, json!("broken"), json!(null)), (1, captured["data"].clone(), json!("../other.docx"))]
        {
            assert!(
                s.run("document.restoreSnapshot", &json!({"version":version,"data":data,"sourcePath":name,"expectedRevision":s.rev().to_string()}))
                    .is_err()
            );
            assert_eq!(s.document_id(), id);
            assert!(!s.dirty);
        }
    }

    #[test]
    fn password_protection_never_leaks_a_plaintext_checkpoint() {
        let mut s = session();
        s.run("file.encrypt", &json!({"password":"synthetic-recovery-fixture"})).unwrap();
        assert!(s.run("document.recoverySnapshot", &json!({})).is_err());
    }

    #[test]
    fn hosted_byte_import_is_unsaved_content_without_an_account_file_identity() {
        let source = crate::sample::sample_document();
        let bytes = crate::io::save_bytes("Import.docx", &source).unwrap();
        let mut target = session();
        let opened = target.run("file.open", &json!({"path":"Import.docx","data":crate::cmd::insert::base64_encode(&bytes),"unsaved":true})).unwrap();
        assert!(target.dirty);
        assert!(target.path.is_none());
        assert!(opened["path"].is_null());
        assert!(target.doc.plain_text(wordcraft_doc::StoryRef::Body).contains("Open Studio"));
        assert!(target.run("document.recoverySnapshot", &json!({})).is_ok());
        let identity = target.document_id();
        assert!(target.run("file.open", &json!({"path":"Import.docx","unsaved":true})).is_err());
        assert_eq!(target.document_id(), identity);
    }
}
