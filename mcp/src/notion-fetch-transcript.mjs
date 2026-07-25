function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function meetingTranscriptRootIds(blocks) {
  const sourceToLocal = new Map();
  const localIds = new Set();
  for (const block of blocks) {
    localIds.add(block.id);
    const raw = recordValue(block.content?.notionBlock);
    const sourceId = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (sourceId) sourceToLocal.set(sourceId, block.id);
  }
  const roots = new Set();
  for (const block of blocks) {
    const raw = recordValue(block.content?.notionBlock);
    const rawType = typeof raw?.type === "string" ? raw.type.trim() : "";
    if (rawType === "transcription") roots.add(block.id);
    const native = block.type === "meeting_notes"
      ? recordValue(block.content?.meetingNotes ?? block.content?.meeting_notes)
      : null;
    const imported = rawType === "meeting_notes" ? recordValue(raw?.meeting_notes) : null;
    const children = recordValue((native ?? imported)?.children);
    const requestedId = typeof (children?.transcript_block_id ?? children?.transcriptBlockId) === "string"
      ? String(children.transcript_block_id ?? children.transcriptBlockId).trim()
      : "";
    if (!requestedId) continue;
    const localId = sourceToLocal.get(requestedId) ?? (localIds.has(requestedId) ? requestedId : "");
    if (localId) roots.add(localId);
  }
  return roots;
}

export function withoutMeetingTranscriptSubtrees(blocks) {
  const hidden = meetingTranscriptRootIds(blocks);
  if (!hidden.size) return blocks;
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (hidden.has(block.id) || !block.parentId || !hidden.has(block.parentId)) continue;
      hidden.add(block.id);
      changed = true;
    }
  }
  return blocks.filter((block) => !hidden.has(block.id));
}

export function meetingTranscriptMarkdown(results, { xmlEscape, escapeFramingBreakouts }) {
  const sections = [];
  for (const result of Array.isArray(results) ? results : []) {
    const transcript = recordValue(result?.transcript);
    if (!transcript) continue;
    const markdown = typeof transcript.markdown === "string"
      ? transcript.markdown
      : typeof transcript.text === "string" ? transcript.text : "";
    if (!markdown.trim()) continue;
    sections.push([
      `<meeting-notes id="${xmlEscape(result?.id ?? "")}">`,
      `<transcript block-id="${xmlEscape(transcript.block_id ?? "")}">`,
      escapeFramingBreakouts(markdown),
      "</transcript>",
      "</meeting-notes>",
    ].join("\n"));
  }
  return sections.join("\n");
}
