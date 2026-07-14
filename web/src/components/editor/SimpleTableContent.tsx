import {
  useEffect,
  useRef,
} from "react";
import { i18next } from "@/i18n";
import { useStore } from "@/lib/store";
import type { Block } from "@/lib/types";
import { Plus, Trash } from "../icons";
import {
  isCaretAtEnd,
  isCaretAtStart,
  isEditableFullySelected,
  placeCaret,
  selectEditableContents,
} from "./focus";
import type { EditorOps } from "./Editor";
import { parseMarkdownTableRows } from "./markdownPaste";
import styles from "./editor.module.css";

function blockItemText(key: string, values?: Record<string, unknown>) {
  return i18next.t(`blockItem:${key}`, values);
}

function normalizeSimpleTable(table?: string[][]) {
  const source = Array.isArray(table) && table.length > 0 ? table : [["", ""], ["", ""]];
  const rowCount = Math.max(2, source.length);
  const colCount = Math.max(2, ...source.map((row) => (Array.isArray(row) ? row.length : 0)));
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: colCount }, (_, colIndex) => source[rowIndex]?.[colIndex] ?? "")
  );
}

function simpleTablePlainText(table: string[][]) {
  return table.map((row) => row.join("\t")).join("\n");
}

type SimpleTableMove = "previous" | "next" | "left" | "right" | "up" | "down";

function parsePastedTable(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const markdownTable = parseMarkdownTableRows(normalized);
  if (markdownTable) return markdownTable;
  if (!normalized.includes("\t") && !normalized.includes("\n")) return null;
  const rows = normalized.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const table = rows.map((row) => row.split("\t"));
  return table.some((row) => row.some((cell) => cell.length > 0)) ? table : null;
}

export function SimpleTableContent({
  block,
  ops,
}: {
  block: Block;
  ops: EditorOps;
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const table = normalizeSimpleTable(block.content?.table);
  const headerRow = block.content?.headerRow ?? true;
  const headerColumn = !!block.content?.headerColumn;

  function commitTable(
    nextTable: string[][],
    opts?: { debounce?: boolean; history?: "merge" | false }
  ) {
    updateBlock(
      block.id,
      {
        content: { ...block.content, table: nextTable },
        plainText: simpleTablePlainText(nextTable),
      },
      opts
    );
  }

  function setCell(rowIndex: number, colIndex: number, value: string) {
    const next = table.map((row) => row.slice());
    next[rowIndex][colIndex] = value;
    commitTable(next, { debounce: true, history: "merge" });
  }

  function addRow(focus = false) {
    const next = [...table, Array.from({ length: table[0]?.length ?? 2 }, () => "")];
    commitTable(next);
    if (focus) focusCell(next.length - 1, 0);
  }

  function addColumn(focus = false) {
    const nextColIndex = table[0]?.length ?? 0;
    commitTable(table.map((row) => [...row, ""]));
    if (focus) focusCell(0, nextColIndex);
  }

  function deleteRow() {
    if (table.length <= 2) return; // keep the 2x2 minimum
    commitTable(table.slice(0, -1));
  }

  function deleteColumn() {
    if ((table[0]?.length ?? 0) <= 2) return; // keep the 2x2 minimum
    commitTable(table.map((row) => row.slice(0, -1)));
  }

  function toggleHeader(key: "headerRow" | "headerColumn") {
    updateBlock(block.id, {
      content: { ...block.content, table, [key]: !block.content?.[key] },
      plainText: simpleTablePlainText(table),
    });
  }

  function focusCell(rowIndex: number, colIndex: number) {
    requestAnimationFrame(() => {
      const selector = `[data-table-cell="${block.id}:${rowIndex}:${colIndex}"]`;
      const cell = document.querySelector<HTMLElement>(selector);
      cell?.focus();
      if (cell) placeCaret(cell, "end");
    });
  }

  function moveCell(rowIndex: number, colIndex: number, move: SimpleTableMove) {
    const colCount = table[0]?.length ?? 0;
    const rowCount = table.length;
    if (move === "previous" || move === "next") {
      const offset = rowIndex * colCount + colIndex + (move === "previous" ? -1 : 1);
      if (offset < 0) return;
      if (offset >= rowCount * colCount) {
        addRow(true);
        return;
      }
      focusCell(Math.floor(offset / colCount), offset % colCount);
    } else if (move === "left" && colIndex > 0) {
      focusCell(rowIndex, colIndex - 1);
    } else if (move === "right" && colIndex < colCount - 1) {
      focusCell(rowIndex, colIndex + 1);
    } else if (move === "up" && rowIndex > 0) {
      focusCell(rowIndex - 1, colIndex);
    } else if (move === "down" && rowIndex < rowCount - 1) {
      focusCell(rowIndex + 1, colIndex);
    }
  }

  function pasteTableAt(rowIndex: number, colIndex: number, text: string) {
    const pasted = parsePastedTable(text);
    if (!pasted) return false;

    const rowCount = Math.max(table.length, rowIndex + pasted.length, 2);
    const colCount = Math.max(
      table[0]?.length ?? 0,
      colIndex + Math.max(...pasted.map((row) => row.length)),
      2
    );
    const next = Array.from({ length: rowCount }, (_, r) =>
      Array.from({ length: colCount }, (_, c) => table[r]?.[c] ?? "")
    );

    pasted.forEach((row, pastedRow) => {
      row.forEach((cell, pastedCol) => {
        next[rowIndex + pastedRow][colIndex + pastedCol] = cell;
      });
    });

    commitTable(next);
    focusCell(rowIndex + pasted.length - 1, colIndex + pasted[pasted.length - 1].length - 1);
    return true;
  }

  return (
    <div className={styles.simpleTableWrap} contentEditable={false}>
        <div
          className={styles.simpleTableScroller}
          role="region"
          aria-label={blockItemText("simpleTable.label")}
        >
          <div className={styles.simpleTableCanvas}>
            <table
              className={styles.simpleTable}
              aria-label={blockItemText("simpleTable.dimensions", {
                rows: table.length,
                columns: table[0]?.length ?? 0,
              })}
            >
              <tbody>
                {table.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, colIndex) => {
                      const isHeader =
                        (headerRow && rowIndex === 0) || (headerColumn && colIndex === 0);
                      const CellTag = isHeader ? "th" : "td";
                      return (
                        <CellTag
                          key={`${rowIndex}-${colIndex}`}
                          data-header={isHeader ? "true" : undefined}
                          scope={
                            isHeader
                              ? rowIndex === 0
                                ? "col"
                                : "row"
                              : undefined
                          }
                        >
                          <SimpleTableCell
                            id={`${block.id}:${rowIndex}:${colIndex}`}
                            value={cell}
                            placeholder={
                              rowIndex === 0 && colIndex === 0
                                ? blockItemText("simpleTable.typeSomething")
                                : ""
                            }
                            readOnly={ops.readOnly}
                            onInput={(value) => setCell(rowIndex, colIndex, value)}
                            onMove={(move) => moveCell(rowIndex, colIndex, move)}
                            onPaste={(text) => pasteTableAt(rowIndex, colIndex, text)}
                            onSelectBlock={() => ops.selectBlock(block.id)}
                          />
                        </CellTag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {!ops.readOnly && (
              <>
                <button
                  type="button"
                  className={styles.simpleTableAddColumn}
                  aria-label={blockItemText("simpleTable.addColumn")}
                  title={blockItemText("columns.add")}
                  onClick={() => addColumn(true)}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.simpleTableAddRow}
                  aria-label={blockItemText("simpleTable.addRow")}
                  title={blockItemText("simpleTable.addRowShort")}
                  onClick={() => addRow(true)}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
        {!ops.readOnly && (
          <div
            className={styles.simpleTableTools}
            aria-label={blockItemText("simpleTable.actions")}
          >
            <button
              type="button"
              aria-label={blockItemText("simpleTable.removeLastRow")}
              title={blockItemText("simpleTable.removeLastRowShort")}
              disabled={table.length <= 2}
              onClick={deleteRow}
            >
              <Trash size={14} aria-hidden="true" />
              <span className={styles.simpleTableToolGlyph} data-kind="row" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={blockItemText("simpleTable.removeLastColumn")}
              title={blockItemText("simpleTable.removeLastColumnShort")}
              disabled={(table[0]?.length ?? 0) <= 2}
              onClick={deleteColumn}
            >
              <Trash size={14} aria-hidden="true" />
              <span className={styles.simpleTableToolGlyph} data-kind="column" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-active={headerRow ? "true" : undefined}
              aria-pressed={headerRow}
              aria-label={blockItemText("simpleTable.toggleHeaderRow")}
              title={blockItemText("simpleTable.headerRow")}
              onClick={() => toggleHeader("headerRow")}
            >
              <span className={styles.simpleTableHeaderGlyph} data-kind="row" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-active={headerColumn ? "true" : undefined}
              aria-pressed={headerColumn}
              aria-label={blockItemText("simpleTable.toggleHeaderColumn")}
              title={blockItemText("simpleTable.headerColumn")}
              onClick={() => toggleHeader("headerColumn")}
            >
              <span className={styles.simpleTableHeaderGlyph} data-kind="column" aria-hidden="true" />
            </button>
          </div>
        )}
    </div>
  );
}

function SimpleTableCell({
  id,
  value,
  placeholder,
  readOnly = false,
  onInput,
  onMove,
  onPaste,
  onSelectBlock,
}: {
  id: string;
  value: string;
  placeholder: string;
  readOnly?: boolean;
  onInput: (value: string) => void;
  onMove: (move: SimpleTableMove) => void;
  onPaste: (text: string) => boolean;
  onSelectBlock: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [, rowPart, columnPart] = id.split(":");
  const rowIndex = Number(rowPart);
  const columnIndex = Number(columnPart);
  const cellLabel =
    Number.isFinite(rowIndex) && Number.isFinite(columnIndex)
      ? blockItemText("simpleTable.cellNumbered", {
          row: rowIndex + 1,
          column: columnIndex + 1,
        })
      : blockItemText("simpleTable.cell");

  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if ((el.textContent ?? "") !== value) el.textContent = value;
    el.dataset.empty = String(value.length === 0);
  }, [value]);

  function handleInput() {
    const el = ref.current;
    if (!el) return;
    const text = el.innerText.replace(/\n+$/g, "");
    el.dataset.empty = String(text.length === 0);
    onInput(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if ((el.textContent?.length ?? 0) === 0 || isEditableFullySelected(el)) {
        window.getSelection()?.removeAllRanges();
        el.blur();
        onSelectBlock();
      } else {
        selectEditableContents(el);
      }
    } else if (e.key === "Escape" && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
      onSelectBlock();
    } else if (e.key === "Tab") {
      e.preventDefault();
      onMove(e.shiftKey ? "previous" : "next");
    } else if (e.key === "ArrowLeft" && isCaretAtStart(el)) {
      e.preventDefault();
      onMove("left");
    } else if (e.key === "ArrowRight" && isCaretAtEnd(el)) {
      e.preventDefault();
      onMove("right");
    } else if (e.key === "ArrowUp" && isCaretAtStart(el)) {
      e.preventDefault();
      onMove("up");
    } else if (e.key === "ArrowDown" && isCaretAtEnd(el)) {
      e.preventDefault();
      onMove("down");
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (!text || !onPaste(text)) return;
    e.preventDefault();
  }

  return (
    <div
      ref={ref}
      className={styles.simpleTableCell}
      contentEditable={!readOnly}
      role="textbox"
      tabIndex={0}
      aria-label={cellLabel}
      aria-readonly={readOnly}
      aria-multiline="true"
      aria-placeholder={placeholder}
      suppressContentEditableWarning
      spellCheck
      data-table-cell={id}
      data-empty={value.length === 0}
      data-placeholder={placeholder}
      onInput={readOnly ? undefined : handleInput}
      onKeyDown={readOnly ? undefined : handleKeyDown}
      onPaste={readOnly ? undefined : handlePaste}
    />
  );
}
