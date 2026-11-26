import assert from 'node:assert/strict';
import test from 'node:test';
import {savePath} from '../dialogs.mjs';

test('Save As supplies the suggested document or export extension', () => {
  assert.equal(savePath('Report', 'Documents/Untitled.docx'), 'Report.docx');
  assert.equal(savePath('Course.v2/Report', 'Original.odt'), 'Course.v2/Report.odt');
  assert.equal(savePath('Summary', 'Documents/Summary.pdf'), 'Summary.pdf');
});

test('Save As preserves explicit formats and rejects invalid account paths', () => {
  assert.equal(savePath('Report.rtf', 'Untitled.docx'), 'Report.rtf');
  assert.throws(() => savePath('../Report', 'Untitled.docx'), /relative to My files/);
  assert.throws(() => savePath('Documents/', 'Untitled.docx'), /relative to My files/);
});
