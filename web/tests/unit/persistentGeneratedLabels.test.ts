import { afterEach, describe, expect, it } from "vitest";
import { i18next } from "@/i18n";
import {
  nextPropertyCopyName,
  persistentGeneratedLabels,
  productLocaleFromLanguage,
} from "@/lib/persistentGeneratedLabels";
import { fileNameFromUrl } from "@/components/database/files";

afterEach(async () => {
  await i18next.changeLanguage("en");
});

describe("persistent generated labels", () => {
  it("uses catalog-backed English names and resolves copy collisions", async () => {
    await i18next.changeLanguage("en");
    const t = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
    const labels = persistentGeneratedLabels(t);
    expect(labels.propertyNames.date).toBe("Date");
    expect(nextPropertyCopyName(
      [{ name: "Amount copy" }, { name: "amount COPY 2" }],
      "Amount",
      t,
    )).toBe("Amount copy 3");
    expect(nextPropertyCopyName([], "", t)).toBe("Untitled copy");
  });

  it("uses catalog-backed Korean names and resolves copy collisions", async () => {
    await i18next.changeLanguage("ko");
    const t = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
    const labels = persistentGeneratedLabels(t);
    expect(labels.propertyNames.date).toBe("날짜");
    expect(labels.statusOptions.doing).toBe("진행 중");
    expect(nextPropertyCopyName(
      [{ name: "금액 사본" }, { name: "금액 사본 2" }],
      "금액",
      t,
    )).toBe("금액 사본 3");
    expect(nextPropertyCopyName([], "", t)).toBe("제목 없음 사본");
    expect(fileNameFromUrl(" ")).toBe("제목 없음");
    expect(fileNameFromUrl("data:image/png;base64,AQID")).toBe("이미지");
  });

  it("normalizes app language tags to the supported product locale", () => {
    expect(productLocaleFromLanguage("ko-KR")).toBe("ko");
    expect(productLocaleFromLanguage("en-US")).toBe("en");
    expect(productLocaleFromLanguage(undefined)).toBe("en");
  });
});
