use std::collections::BTreeSet;

use serde_json::{Value, json};
use wordcraft_doc::para::{AltText, Anchor, Float, FloatAlign, InlineObject, OBJ, Wrap};
use wordcraft_doc::picfx::PicFx;
use wordcraft_doc::props::CharProps;
use wordcraft_doc::{Document, Paragraph, PartKind, StoryRef, para_block};

use crate::cmd::{insert, sel_result};
use crate::{CmdError, CmdResult, Session, p};

const TITLE: &str = "WordCraft picture watermark";

fn is_picture_watermark(object: &InlineObject) -> bool {
    matches!(object, InlineObject::Image { float, ole:None, .. }
        if float.wrap == Wrap::BehindText && float.alt.decorative && float.alt.title == TITLE)
}

fn header_ids(doc: &Document) -> impl Iterator<Item = u32> + '_ {
    doc.parts.iter().filter_map(|(&id, part)| (part.kind == PartKind::Header).then_some(id))
}

pub(super) fn clear_pictures(doc: &mut Document) -> Result<(), CmdError> {
    for id in header_ids(doc).collect::<Vec<_>>() {
        let story = StoryRef::Part(id);
        for path in doc.para_paths(story) {
            let Some(para) = doc.para(story, &path) else { continue };
            let offsets =
                para.objects_with_offsets().filter(|(_, object)| is_picture_watermark(object)).map(|(offset, _)| offset).collect::<Vec<_>>();
            if !offsets.is_empty() {
                let para = doc.para_mut(story, &path)?;
                for offset in offsets.into_iter().rev() {
                    para.delete(offset, offset + OBJ.len_utf8())?;
                }
            }
        }
    }
    Ok(())
}

fn watermark_headers(session: &mut Session) -> Result<BTreeSet<u32>, CmdError> {
    let sections = session.doc.sections();
    let needs_first = sections.iter().any(|(_, section)| section.title_page);
    let (first_block, first) = sections[0];
    let first = first.headers;
    let mut ids = sections
        .iter()
        .flat_map(|(_, section)| [section.headers.default, section.headers.first, section.headers.even])
        .flatten()
        .filter(|id| session.doc.parts.get(id).is_some_and(|part| part.kind == PartKind::Header))
        .collect::<BTreeSet<_>>();
    for (needed, existing, slot) in
        [(true, first.default, wordcraft_layout::HfSlot::Default), (needs_first, first.first, wordcraft_layout::HfSlot::First)]
    {
        if !needed || existing.is_some_and(|id| ids.contains(&id)) {
            continue;
        }
        let id = session.doc.try_add_part(PartKind::Header, vec![para_block(Paragraph::new().styled("Header"))])?;
        let headers = &mut session.doc.section_mut(first_block).headers;
        match slot {
            wordcraft_layout::HfSlot::Default => headers.default = Some(id),
            wordcraft_layout::HfSlot::First => headers.first = Some(id),
            wordcraft_layout::HfSlot::Even => headers.even = Some(id),
        }
        session.new_header_parts.push(id);
        ids.insert(id);
    }
    Ok(ids)
}

pub(super) fn picture(session: &mut Session, params: &Value) -> CmdResult {
    let scale = p::u64(params, "scale").unwrap_or(50);
    let fade = p::u64(params, "fade").unwrap_or(80);
    if !(10..=100).contains(&scale) || fade > 95 {
        return Err(CmdError::Params("picture scale must be 10–100%, and fade 0–95%".into()));
    }
    let image = insert::picture_input(params)?.ok_or_else(|| CmdError::Params("choose a picture for the watermark".into()))?;
    let (natural_w, natural_h, ext) = insert::natural_picture_size(&image)?;
    let factor = session
        .doc
        .sections()
        .iter()
        .map(|(_, section)| {
            (section.text_width().max(4.0) / natural_w).min((section.page_h - section.margin_top - section.margin_bottom).max(4.0) / natural_h)
        })
        .fold(f32::INFINITY, f32::min)
        * scale as f32
        / 100.0;
    let (width, height) = (natural_w * factor, natural_h * factor);
    let headers = watermark_headers(session)?;
    clear_pictures(&mut session.doc)?;
    session.doc.settings.watermark = None;
    let media = session.doc.add_media(image, ext);
    let image = InlineObject::Image {
        media,
        w: width,
        h: height,
        alt: String::new(),
        float: Float {
            wrap: Wrap::BehindText,
            h_rel: Anchor::Page,
            v_rel: Anchor::Page,
            h_align: Some(FloatAlign::Center),
            v_align: Some(FloatAlign::Center),
            outside_cell: true,
            alt: AltText { title: TITLE.into(), decorative: true, ..Default::default() },
            ..Default::default()
        },
        crop: [0.0; 4],
        fx: PicFx::new(0, 0, fade as i32 * 1_000),
        ole: None,
    };
    for id in headers {
        let story = StoryRef::Part(id);
        let path = session.doc.start_of(story).path;
        let para = session.doc.para_mut(story, &path)?;
        para.insert_object(para.len(), image.clone(), &CharProps::default())?;
    }
    sel_result(session).map(|mut status| {
        status["picture"] = json!(true);
        status
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> String {
        let image = image::RgbaImage::from_pixel(40, 20, image::Rgba([33, 130, 206, 255]));
        let bytes = wordcraft_geom::picture::encode_format(&image.into(), image::ImageFormat::Png).unwrap();
        insert::base64_encode(&bytes)
    }

    fn pictures(doc: &Document, id: u32) -> Vec<&InlineObject> {
        doc.parts[&id]
            .blocks
            .iter()
            .filter_map(|block| block.as_para())
            .flat_map(|para| &para.objects)
            .filter(|object| is_picture_watermark(object))
            .collect()
    }

    #[test]
    fn picture_watermark_round_trips_preserves_headers_and_removes_only_its_image() {
        let mut s = Session::new(Document::new());
        s.run("text.insert", &json!({"text": "Page one"})).unwrap();
        s.run("insert.pageBreak", &json!({})).unwrap();
        s.run("text.insert", &json!({"text": "Page two"})).unwrap();
        s.run("insert.header", &json!({"text":"Existing header"})).unwrap();
        s.run("insert.picture", &json!({"data":png()})).unwrap();
        s.run("insert.closeHeader", &json!({})).unwrap();
        let id = s.doc.last_section.headers.default.unwrap();
        s.doc.last_section.title_page = true;
        s.run("design.watermark", &json!({"data":png(),"scale":45,"fade":67})).unwrap();
        let first = s.doc.last_section.headers.first.unwrap();
        let layout = s.layout();
        assert_eq!(layout.pages.len(), 2);
        assert_eq!(layout.pages[0].header_story, Some(first));
        assert_eq!(layout.pages[1].header_story, Some(id));
        let saved = wordcraft_docx::write(&s.doc).unwrap();
        let mut opened = Session::new(wordcraft_docx::read(&saved).unwrap());
        let id = opened.doc.last_section.headers.default.unwrap();
        let first = opened.doc.last_section.headers.first.unwrap();
        assert_ne!(id, first);
        for part in [id, first] {
            let marks = pictures(&opened.doc, part);
            let [InlineObject::Image { w, h, fx, float, .. }] = marks.as_slice() else { panic!("missing watermark") };
            assert_eq!(float.wrap, Wrap::BehindText);
            assert_eq!(float.h_align, Some(FloatAlign::Center));
            assert_eq!(float.v_rel, Anchor::Page);
            assert_eq!(fx.transparency, 67_000);
            assert!((w / h - 2.0).abs() < 0.01);
        }
        let before = opened.doc.plain_text(StoryRef::Part(id));
        assert!(before.contains("Existing header"));
        opened.run("design.watermark", &json!({"remove":true})).unwrap();
        assert!(pictures(&opened.doc, id).is_empty());
        assert!(pictures(&opened.doc, first).is_empty());
        assert_eq!(opened.doc.plain_text(StoryRef::Part(id)), before);
        let other_images = opened.doc.parts[&id]
            .blocks
            .iter()
            .filter_map(|block| block.as_para())
            .flat_map(|para| &para.objects)
            .filter(|obj| matches!(obj, InlineObject::Image { .. }))
            .count();
        assert_eq!(other_images, 1);
    }

    #[test]
    fn picture_watermark_invalid_input_does_not_replace_text_watermark() {
        let mut s = Session::new(Document::new());
        s.run("design.watermark", &json!({"text":"Draft"})).unwrap();
        assert!(s.run("design.watermark", &json!({"data":"no image"})).is_err());
        assert_eq!(s.doc.settings.watermark.as_ref().unwrap().text, "Draft");
        s.run("design.watermark", &json!({"data":png()})).unwrap();
        assert!(s.doc.settings.watermark.is_none());
        s.run("design.watermark", &json!({"text":"Confidential"})).unwrap();
        assert!(pictures(&s.doc, s.doc.last_section.headers.default.unwrap()).is_empty());
        assert_eq!(s.doc.settings.watermark.as_ref().unwrap().text, "Confidential");
    }
}
