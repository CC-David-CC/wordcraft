# WordCraft phone qualification

Launch **Office → WordCraft** in WebOS. The WebOS wrapper is `webos/index.mjs`. Build the browser engine with `webos/build.py --profile release` and select the prepared component with `--wordcraft-site` in the viewer builder.

The phone baseline covers editing text and managing the editable account document. These are two of ten workflow areas. The remaining areas are formatting, find and replace, pictures and tables, page layout, review, export and printing, templates and preferences, and references and mail merge.

1. Open WordCraft and type a short line in a blank document.
2. Select **Save**. The dialog suggests `Documents/Untitled.docx`. Type a bare name and confirm the editable `.docx` is saved.
3. Close the editor. Select the saved file in My files and use **Open**. WordCraft opens with the same editable text.
4. Open and dismiss the software keyboard. Verify WordCraft fits the available height and its compact navigation stays reachable.

The Galaxy S10+ replay used Chrome `158.0.8127.92` at 411 CSS pixels, wrapper source `a61f5c3d`, and engine source `84522b41`. WordCraft fit a 480 CSS-pixel editor height with the keyboard open, then expanded to 724 CSS pixels after dismissal. The editable file reopened through the real Files action. [Physical phone screenshot and steps](https://github.com/CC-David-CC/wordcraft/blob/webos/qa-phone/docs/webos-qa/PHONE.md)

The default extension comes from the suggested document or export path. The Node wrapper tests verify DOCX, ODT and PDF defaults, an explicit RTF name, and rejection of invalid account paths. Continue testing each corresponding format through the native desktop and file-picker workflows. The filename fix is staged locally.
