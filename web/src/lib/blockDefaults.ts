import type { Block, BlockContent, BlockType } from "./types";

export const DEFAULT_CODE_BLOCK_LANGUAGE = "javascript";

export function contentForNewBlock(
  type: BlockType,
  explicitContent?: BlockContent
): BlockContent {
  if (explicitContent != null) return explicitContent;
  return type === "code"
    ? { rich: [], language: DEFAULT_CODE_BLOCK_LANGUAGE }
    : { rich: [] };
}

export function contentForBlockTypeChange(
  textContent: BlockContent,
  previousBlock: Pick<Block, "type" | "content"> | undefined,
  nextType: BlockType
): BlockContent {
  if (nextType !== "code") return textContent;
  if (previousBlock?.type !== "code") {
    return { ...textContent, language: DEFAULT_CODE_BLOCK_LANGUAGE };
  }
  if (!previousBlock.content) return textContent;
  return {
    ...previousBlock.content,
    rich: textContent.rich,
  };
}
