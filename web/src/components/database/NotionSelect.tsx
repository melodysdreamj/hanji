"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDown } from "../icons";
import styles from "./database.module.css";

export type NotionSelectOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export function NotionSelect({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  className,
  buttonClassName,
  menuClassName,
  optionClassName,
}: {
  ariaLabel: string;
  value: string;
  options: NotionSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  backdropClassName?: string;
  menuClassName?: string;
  optionClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const selectId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const exactSelectedIndex = options.findIndex((option) => option.value === value);
  const selectedIndex = exactSelectedIndex >= 0 ? exactSelectedIndex : 0;
  const selected = options[selectedIndex] ?? options[0];
  const activeOptionId =
    open && !options[activeIndex]?.disabled ? `${selectId}-option-${activeIndex}` : undefined;
  const enabledIndexes = useMemo(
    () => options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0),
    [options],
  );

  const updateMenuStyle = useCallback(() => {
    const trigger = buttonRef.current;
    if (!trigger) return;
    const margin = 8;
    const gap = 4;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.max(220, Math.min(Math.max(rect.width, 220), window.innerWidth - margin * 2));
    const preferredLeft = rect.left + menuWidth > window.innerWidth - margin
      ? rect.right - menuWidth
      : rect.left;
    const left = Math.min(
      Math.max(margin, preferredLeft),
      Math.max(margin, window.innerWidth - menuWidth - margin)
    );
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const openAbove = below < 150 && above > below;
    const maxHeight = Math.max(120, Math.min(270, openAbove ? above : below));
    setMenuStyle({
      position: "fixed",
      left,
      width: menuWidth,
      maxHeight,
      ...(openAbove
        ? { bottom: Math.max(margin, window.innerHeight - rect.top + gap), top: "auto" }
        : { bottom: "auto", top: Math.min(rect.bottom + gap, window.innerHeight - margin) }),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuStyle();
    window.addEventListener("resize", updateMenuStyle);
    window.addEventListener("scroll", updateMenuStyle, true);
    return () => {
      window.removeEventListener("resize", updateMenuStyle);
      window.removeEventListener("scroll", updateMenuStyle, true);
    };
  }, [open, options.length, updateMenuStyle]);

  useEffect(() => {
    if (!open) return;

    function isInsideSelect(target: EventTarget | null) {
      if (!(target instanceof Node)) return false;
      return !!buttonRef.current?.contains(target) || !!menuRef.current?.contains(target);
    }

    function onPointerDown(event: PointerEvent) {
      if (isInsideSelect(event.target)) return;
      setOpen(false);
    }

    function onFocusIn(event: FocusEvent) {
      if (isInsideSelect(event.target)) return;
      setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => {
      const active = menuRef.current?.querySelector<HTMLButtonElement>("[data-active='true']");
      if (active && !active.disabled) active.focus();
      else menuRef.current?.focus();
    }, 0);
  }, [open]);

  function firstEnabledIndex() {
    return enabledIndexes[0] ?? 0;
  }

  function lastEnabledIndex() {
    return enabledIndexes[enabledIndexes.length - 1] ?? Math.max(0, options.length - 1);
  }

  function openMenu() {
    if (disabled || options.length === 0) return;
    updateMenuStyle();
    setActiveIndex(options[selectedIndex]?.disabled ? firstEnabledIndex() : selectedIndex);
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => buttonRef.current?.focus(), 0);
  }

  function moveActive(direction: -1 | 1) {
    if (enabledIndexes.length === 0) return;
    setActiveIndex((current) => {
      let next = current;
      for (let i = 0; i < options.length; i += 1) {
        next = (next + direction + options.length) % options.length;
        if (!options[next]?.disabled) {
          focusActiveOption(next);
          return next;
        }
      }
      return current;
    });
  }

  function focusActiveOption(index: number) {
    window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>(`[data-option-index="${index}"]`)
        ?.focus();
    });
  }

  function setActiveAndFocus(index: number) {
    setActiveIndex(index);
    focusActiveOption(index);
  }

  function selectOption(option: NotionSelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  }

  function onButtonKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    openMenu();
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      moveActive(-1);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      setActiveAndFocus(firstEnabledIndex());
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setActiveAndFocus(lastEnabledIndex());
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      moveActive(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const option = options[activeIndex];
      if (option) selectOption(option);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    }
  }

  const menuLayer = open ? (
    <div
      ref={menuRef}
      className={`${styles.notionSelectMenu} ${menuClassName ?? ""}`}
      style={menuStyle}
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-activedescendant={activeOptionId}
      onKeyDown={onMenuKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          id={`${selectId}-option-${index}`}
          type="button"
          className={`${styles.notionSelectOption} ${optionClassName ?? ""}`}
          tabIndex={index === activeIndex && !option.disabled ? 0 : -1}
          data-option-index={index}
          data-active={index === activeIndex ? "true" : undefined}
          role="menuitemradio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          onMouseEnter={() => {
            if (!option.disabled) setActiveIndex(index);
          }}
          onClick={() => selectOption(option)}
        >
          {option.icon ? (
            <span className={styles.notionSelectIcon} aria-hidden="true">
              {option.icon}
            </span>
          ) : (
            <span className={styles.notionSelectIcon} aria-hidden="true" />
          )}
          <span className={styles.notionSelectLabel}>{option.label}</span>
          {option.value === value ? <CheckIcon size={13} aria-hidden="true" /> : null}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <span className={`${styles.notionSelect} ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.notionSelectButton} ${buttonClassName ?? ""}`}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onButtonKeyDown}
      >
        {selected?.icon ? (
          <span className={styles.notionSelectIcon} aria-hidden="true">
            {selected.icon}
          </span>
        ) : null}
        <span className={styles.notionSelectLabel}>{selected?.label ?? ""}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menuLayer && (typeof document === "undefined" ? menuLayer : createPortal(menuLayer, document.body))}
    </span>
  );
}
