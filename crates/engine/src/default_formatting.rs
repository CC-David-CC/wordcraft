//! Versioned formatting for new blank documents, separate from any document's contents.
use std::{collections::HashSet, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wordcraft_doc::{Document, props::Rgb, styles::StyleSheet};

use crate::{CmdError, CmdResult};

const MAX_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DefaultFormatting {
    version: u8,
    styles: StyleSheet,
    major_font: String,
    minor_font: String,
    theme_colors: Vec<Rgb>,
}

impl DefaultFormatting {
    pub(crate) fn capture(doc: &Document) -> Result<Self, CmdError> {
        let mut styles = doc.styles.as_ref().clone();
        // Tracked style-edit authors and their previous values are document history,
        // not defaults. Never carry that provenance into another blank document.
        for style in &mut styles.styles {
            style.para_change = None;
            style.chr_change = None;
        }
        let result = Self {
            version: 1,
            styles,
            major_font: doc.settings.major_font.clone(),
            minor_font: doc.settings.minor_font.clone(),
            theme_colors: doc.settings.theme_colors.clone(),
        };
        result.validate()?;
        Ok(result)
    }

    pub(crate) fn parse(value: &Value) -> Result<Self, CmdError> {
        let bytes = serde_json::to_vec(value).map_err(|_| CmdError::Params("Cannot encode default formatting".into()))?;
        if bytes.len() > MAX_BYTES {
            return Err(CmdError::Params("Default formatting exceeds 256 KiB".into()));
        }
        let result: Self = serde_json::from_slice(&bytes).map_err(|_| CmdError::Params("Invalid default formatting".into()))?;
        result.validate()?;
        Ok(result)
    }

    fn validate(&self) -> Result<(), CmdError> {
        let mut ids = HashSet::new();
        if self.version != 1
            || self.styles.styles.is_empty()
            || self.styles.styles.len() > 512
            || self.theme_colors.len() != 12
            || [&self.major_font, &self.minor_font].iter().any(|font| font.is_empty() || font.len() > 256)
            || self.styles.styles.iter().any(|style| style.id.is_empty() || style.id.len() > 256 || !ids.insert(style.id.as_str()))
        {
            return Err(CmdError::Params("Invalid default formatting".into()));
        }
        if serde_json::to_vec(self).map_err(|_| CmdError::Params("Cannot encode default formatting".into()))?.len() > MAX_BYTES {
            return Err(CmdError::Params("Default formatting exceeds 256 KiB".into()));
        }
        Ok(())
    }

    pub(crate) fn value(&self) -> CmdResult {
        serde_json::to_value(self).map_err(|_| CmdError::Params("Cannot encode default formatting".into()))
    }

    pub(crate) fn apply(&self, doc: &mut Document) {
        doc.styles = Arc::new(self.styles.clone());
        doc.settings.major_font.clone_from(&self.major_font);
        doc.settings.minor_font.clone_from(&self.minor_font);
        doc.settings.theme_colors.clone_from(&self.theme_colors);
    }
}
