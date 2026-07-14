"use client";

import { type MouseEvent, type ReactNode, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceFileUrl } from "@/lib/fileUrls";
import { openPdfInNewTab } from "@/lib/pdfPreview";
import type { FileAttachment } from "@/lib/types";
import { ImagePreviewDialog } from "../ImagePreviewDialog";
import { isPdfAttachment, isPreviewableImageAttachment } from "./files";

export function AttachmentOpenLink({
  file,
  className,
  ariaLabel,
  children,
}: {
  file: FileAttachment;
  className: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("blockItem");
  const href = useWorkspaceFileUrl(file.url, ["data:"]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfViewerReady, setPdfViewerReady] = useState(false);
  const image = isPreviewableImageAttachment(file);
  const pdf = isPdfAttachment(file);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  if (!href) return <span className={className}>{children}</span>;

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    event.stopPropagation();
    if (image) {
      event.preventDefault();
      setPreviewOpen(true);
      return;
    }
    if (pdf) {
      event.preventDefault();
      setPdfViewerReady(false);
      void openPdfInNewTab(() => href, file.name, () => setPdfViewerReady(true));
    }
  }

  return (
    <>
      <a
        className={className}
        href={href}
        target={pdf || (!image && /^https?:\/\//i.test(href)) ? "_blank" : undefined}
        rel="noreferrer noopener"
        download={!image && !pdf ? file.name || undefined : undefined}
        aria-label={ariaLabel}
        aria-haspopup={image ? "dialog" : undefined}
        aria-expanded={image ? previewOpen : undefined}
        data-attachment-open
        data-attachment-kind={image ? "image" : pdf ? "pdf" : "download"}
        data-pdf-viewer-ready={pdf && pdfViewerReady ? "true" : undefined}
        onClick={onClick}
        onAuxClick={(event) => event.stopPropagation()}
      >
        {children}
      </a>
      {previewOpen && (
        <ImagePreviewDialog
          src={href}
          alt={file.name}
          label={t("image.preview")}
          closeLabel={t("image.closePreview")}
          onClose={closePreview}
        />
      )}
    </>
  );
}
