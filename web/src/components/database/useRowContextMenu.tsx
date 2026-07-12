"use client";

import { type MouseEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { RowMenu } from "../RowMenu";

export type RowOpenMode = "side" | "center" | "full";

type RowMenuState = {
  pageId: string;
  anchor: { x: number; y: number };
};

export function useRowContextMenu(options: {
  onEditProperties?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: RowOpenMode) => void;
} = {}): {
  openRowContextMenu: (pageId: string, e: MouseEvent<HTMLElement>) => void;
  openRowContextMenuAt: (
    pageId: string,
    anchor: { x: number; y: number },
    returnTo?: HTMLElement | null,
  ) => void;
  openRowContextMenuFromElement: (pageId: string, returnTo?: HTMLElement | null) => void;
  rowContextMenu: ReactNode;
} {
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const returnToRef = useRef<HTMLElement | null>(null);

  const openRowContextMenuAt = useCallback(
    (pageId: string, anchor: { x: number; y: number }, returnTo?: HTMLElement | null) => {
      returnToRef.current =
        returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setMenu({ pageId, anchor });
    },
    []
  );

  const openRowContextMenuFromElement = useCallback(
    (pageId: string, returnTo?: HTMLElement | null) => {
      const target =
        returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      const rect = target?.getBoundingClientRect();
      openRowContextMenuAt(
        pageId,
        rect ? { x: rect.left + 16, y: rect.top + Math.min(rect.height, 32) } : { x: 16, y: 16 },
        target,
      );
    },
    [openRowContextMenuAt]
  );

  const openRowContextMenu = useCallback(
    (pageId: string, e: MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const control = target.closest("button, input, select, textarea, a");
      if (control && control !== e.currentTarget) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = e.currentTarget.getBoundingClientRect();
      const keyboardFallback = e.clientX === 0 && e.clientY === 0;
      openRowContextMenuAt(
        pageId,
        keyboardFallback
          ? { x: rect.left + 16, y: rect.top + Math.min(rect.height, 32) }
          : { x: e.clientX, y: e.clientY },
        e.currentTarget,
      );
    },
    [openRowContextMenuAt]
  );

  const closeRowContextMenu = useCallback(() => {
    setMenu(null);
    window.requestAnimationFrame(() => {
      if (returnToRef.current?.isConnected) {
        returnToRef.current.focus();
      }
      returnToRef.current = null;
    });
  }, []);

  return {
    openRowContextMenu,
    openRowContextMenuAt,
    openRowContextMenuFromElement,
    rowContextMenu: menu ? (
      <RowMenu
        pageId={menu.pageId}
        anchor={menu.anchor}
        onClose={closeRowContextMenu}
        onEditProperties={options.onEditProperties}
        onOpenRowIn={options.onOpenRowIn}
        variant="database-row"
      />
    ) : null,
  };
}
