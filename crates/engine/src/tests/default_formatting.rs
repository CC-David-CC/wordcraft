use super::*;

#[test]
fn default_formatting_changes_only_new_blank_documents() {
    let mut session = s();
    run(&mut session, "text.insert", json!({"text":"Private content must not become a template"}));
    run(&mut session, "design.themeFonts", json!({"heading":"Source Serif 4","body":"Source Sans 3"}));
    run(&mut session, "design.styleSet", json!({"name":"shaded"}));
    run(&mut session, "design.themeColors", json!({"name":"Studio"}));
    run(&mut session, "design.paragraphSpacing", json!({"value":"relaxed"}));
    let original = session.doc.clone();
    let revision = session.rev();
    let dirty = session.dirty;
    let defaults = run(&mut session, "design.setDefault", json!({}));
    assert_eq!(session.doc, original);
    assert_eq!(session.rev(), revision);
    assert_eq!(session.dirty, dirty);
    assert!(!defaults.to_string().contains("Private content"));
    assert!(defaults.get("body").is_none());
    assert!(defaults.get("metadata").is_none());
    run(&mut session, "file.new", json!({"template":"blank"}));
    assert!(text(&session).trim().is_empty());
    assert_eq!(session.doc.styles, original.styles);
    assert_eq!(session.doc.settings.major_font, "Source Serif 4");
    assert_eq!(session.doc.settings.minor_font, "Source Sans 3");
    assert_eq!(session.doc.settings.theme_colors, original.settings.theme_colors);
    assert!(!session.dirty, "a default-formatted blank is still an untouched blank");

    // Explicit templates retain their own design rather than inheriting the Normal template.
    let mut control = s();
    run(&mut control, "file.new", json!({"template":"letter"}));
    run(&mut session, "file.new", json!({"template":"letter"}));
    assert_eq!(session.doc.styles, control.doc.styles);
    assert_eq!(session.doc.settings.major_font, control.doc.settings.major_font);
}

#[test]
fn serialized_defaults_restore_into_another_session_without_reformatting_loaded_or_recovered_documents() {
    let mut source = s();
    run(&mut source, "design.themeFonts", json!({"heading":"Inter","body":"JetBrains Mono"}));
    let defaults = run(&mut source, "design.defaultSnapshot", json!({}));
    let mut session = s();
    run(&mut session, "text.insert", json!({"text":"Existing document"}));
    let existing = session.doc.clone();
    let revision = session.rev();
    let dirty = session.dirty;
    run(&mut session, "design.loadDefaults", defaults.clone());
    assert_eq!(session.doc, existing);
    assert_eq!(session.rev(), revision);
    assert_eq!(session.dirty, dirty);

    let recovery = run(&mut session, "document.recoverySnapshot", json!({}));
    let bytes = wordcraft_docx::write(&existing).unwrap();
    let mut control = s();
    let params = json!({"path":"Existing.docx","data":crate::cmd::insert::base64_encode(&bytes)});
    run(&mut control, "file.open", params.clone());
    run(&mut session, "file.open", params);
    assert_eq!(session.doc, control.doc, "Open must retain the file's formatting");
    run(&mut session, "file.new", json!({}));
    assert_eq!(session.doc.settings.minor_font, "JetBrains Mono");
    assert_eq!(session.doc.settings.major_font, "Inter");
    let expected_revision = session.rev().to_string();
    run(
        &mut session,
        "document.restoreSnapshot",
        json!({"version":recovery["version"],"data":recovery["data"],"expectedRevision":expected_revision,"sourcePath":null}),
    );
    assert_eq!(session.doc, existing, "recovered formatting must not inherit current defaults");
    assert_ne!(s().doc.settings.minor_font, "JetBrains Mono", "unrelated sessions have no inherited account defaults");
}

#[test]
fn invalid_defaults_fail_atomically_and_keep_previously_loaded_defaults() {
    let mut session = s();
    run(&mut session, "design.themeFonts", json!({"heading":"Inter","body":"Source Sans 3"}));
    let defaults = run(&mut session, "design.setDefault", json!({}));
    let original = session.doc.clone();
    let revision = session.rev();
    let mut bad = defaults.clone();
    bad["version"] = json!(2);
    assert!(session.run("design.loadDefaults", &bad).is_err());
    bad = defaults.clone();
    bad["body"] = json!(["Document contents are not defaults"]);
    assert!(session.run("design.loadDefaults", &bad).is_err());
    bad = defaults.clone();
    let duplicate = bad["styles"]["styles"][0].clone();
    bad["styles"]["styles"].as_array_mut().unwrap().push(duplicate);
    assert!(session.run("design.loadDefaults", &bad).is_err());
    bad = defaults.clone();
    bad["majorFont"] = json!("x".repeat(256 * 1024));
    assert!(session.run("design.loadDefaults", &bad).is_err());
    assert_eq!(session.doc, original);
    assert_eq!(session.rev(), revision);
    run(&mut session, "file.new", json!({}));
    assert_eq!(session.doc.settings.major_font, "Inter");
}
