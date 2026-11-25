//! Preferences between visits (#2132): the same [`Prefs`] the desktop app keeps in its settings
//! file (theme, interface size, recent symbols, editing options…), kept by the settings store in the
//! browser's `localStorage`. A value stored by an earlier build under `wordcraft.ui` is imported once.

use craft::settings::SharedSettings;
use wordcraft_ui_egui::prefs::Prefs;

/// The `localStorage` key.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub const KEY: &str = "wordcraft.ui";

/// Hosted recent-file names and author preferences belong to one account.
/// An absent/invalid public profile disables persistence rather than falling
/// back to another account's unscoped browser preferences.
pub fn storage_key(hosted: bool, profile: Option<&str>) -> Option<String> {
    scoped_key(KEY, hosted, profile)
}

/// Uploaded fonts have the same account boundary as recent files/preferences.
pub fn font_database_key(hosted: bool, profile: Option<&str>) -> Option<String> {
    scoped_key("wordcraft", hosted, profile)
}

fn scoped_key(base: &str, hosted: bool, profile: Option<&str>) -> Option<String> {
    if !hosted {
        return Some(base.into());
    }
    profile
        .filter(|value| {
            !value.is_empty() && value.len() <= 256 && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':'))
        })
        .map(|value| format!("{base}.host.{value}"))
}

/// Opens the settings store over the browser's `localStorage`. Changes are written at once on the
/// next tick: a reload or closed tab never runs exit code.
#[cfg(target_arch = "wasm32")]
pub fn open(hosted: bool, profile: Option<&str>) -> (SharedSettings<Prefs>, craft::settings::LoadReport) {
    use std::sync::Arc;
    use craft::settings::{LocalStorageFiles, SettingsStore};

    const MAX_STORED: usize = 4 << 20;
    let (store, report) = SettingsStore::open_with(options(hosted, profile).files(Arc::new(LocalStorageFiles::new(MAX_STORED))));
    (SharedSettings::new(store), report)
}

#[cfg(any(target_arch = "wasm32", test))]
fn options(hosted: bool, profile: Option<&str>) -> craft::settings::OpenOptions<Prefs> {
    use std::time::Duration;
    use craft::settings::{LegacyFile, Location, OpenOptions};
    use wordcraft_ui_egui::prefs::legacy_ui_json;

    let location = scoped_key("wordcraft", hosted, profile).map_or(Location::Memory, |path| Location::Dir(path.into()));
    let legacy = storage_key(hosted, profile)
        .map(|path| LegacyFile { path: path.into(), parse: legacy_ui_json })
        .into_iter()
        .collect();
    OpenOptions::new(location).debounce(Duration::ZERO).legacy(legacy)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use craft::settings::testing::MemoryFiles;
    use craft::settings::SettingsStore;

    use super::*;

    #[test]
    fn hosted_preferences_do_not_fall_back_to_unscoped_or_other_accounts() {
        assert_eq!(storage_key(false, None).as_deref(), Some(KEY));
        assert_eq!(storage_key(true, None), None);
        assert_eq!(storage_key(true, Some("../invalid")), None);
        let a = storage_key(true, Some("synthetic-account-a"));
        let b = storage_key(true, Some("synthetic-account-b"));
        assert!(a.is_some());
        assert_ne!(a, b);
        assert_ne!(a.as_deref(), Some(KEY));
        assert!(storage_key(true, Some("user:00000000-0000-0000-0000-000000000001")).is_some());
        assert_eq!(font_database_key(false, None).as_deref(), Some("wordcraft"));
        assert_eq!(font_database_key(true, None), None);
        assert_eq!(font_database_key(true, Some("../invalid")), None);
        assert_ne!(font_database_key(true, Some("synthetic-account-a")), font_database_key(true, Some("synthetic-account-b")));
        assert_ne!(font_database_key(true, Some("synthetic-account-a")).as_deref(), Some("wordcraft"));
    }

    #[test]
    fn imports_account_preferences_and_defaults_on_junk() {
        use std::path::Path;
        use craft::settings::SettingsFiles;
        use wordcraft_ui_egui::theme::Appearance;
        let files = Arc::new(MemoryFiles::new());
        files.write(Path::new("wordcraft.ui.host.synthetic-a"), r#"{"theme":"dark","recent":["Draft.docx"]}"#).unwrap();
        files.write(Path::new("wordcraft.ui.host.synthetic-b"), "not json").unwrap();
        files.write(Path::new("wordcraft.ui"), r#"{"theme":"light","recent":["Standalone.docx"]}"#).unwrap();
        let read = |hosted, profile| SettingsStore::open_with(options(hosted, profile).files(files.clone())).0;
        let account = read(true, Some("synthetic-a"));
        assert_eq!(account.get().theme, Appearance::Dark);
        assert_eq!(account.get().recent, ["Draft.docx"]);
        let other = read(true, Some("synthetic-b"));
        assert_eq!(other.get().theme, Appearance::System);
        assert!(other.get().recent.is_empty());
        assert!(read(true, None).get().recent.is_empty());
        assert_eq!(read(false, None).get().recent, ["Standalone.docx"]);
    }
}
