export type PersistentGeneratedLocale = 'en' | 'ko';

export interface PersistentGeneratedLabels {
  untitled: string;
  importedDatabase: string;
  importedFromNotion: string;
  linkedDatabase: string;
  propertyNames: {
    name: string;
    date: string;
  };
  viewNames: {
    table: string;
  };
  columnName(number: number): string;
  copyName(name: string): string;
}

const LABELS: Record<PersistentGeneratedLocale, Omit<PersistentGeneratedLabels, 'columnName' | 'copyName'>> = {
  en: {
    untitled: 'Untitled',
    importedDatabase: 'Imported database',
    importedFromNotion: 'Imported from Notion',
    linkedDatabase: 'Linked database',
    propertyNames: {
      name: 'Name',
      date: 'Date',
    },
    viewNames: {
      table: 'Table',
    },
  },
  ko: {
    untitled: '제목 없음',
    importedDatabase: '가져온 데이터베이스',
    importedFromNotion: 'Notion에서 가져옴',
    linkedDatabase: '연결된 데이터베이스',
    propertyNames: {
      name: '이름',
      date: '날짜',
    },
    viewNames: {
      table: '표',
    },
  },
};

/**
 * Product callers may opt into localized generated resource names. Protocol,
 * API, and MCP callers that omit the field deliberately retain the historical
 * English defaults. Unknown values fail closed instead of silently persisting
 * a mixture of languages.
 */
export function parsePersistentGeneratedLocale(
  value: unknown,
  field = 'locale',
): PersistentGeneratedLocale {
  if (value === undefined || value === null || value === '') return 'en';
  if (value === 'en' || value === 'ko') return value;
  throw new Error(`${field} must be "en" or "ko".`);
}

export function persistentGeneratedLabels(
  locale: PersistentGeneratedLocale,
): PersistentGeneratedLabels {
  const labels = LABELS[locale];
  return {
    ...labels,
    propertyNames: { ...labels.propertyNames },
    viewNames: { ...labels.viewNames },
    columnName(number: number) {
      return locale === 'ko' ? `열 ${number}` : `Column ${number}`;
    },
    copyName(name: string) {
      const base = name.trim() || labels.untitled;
      return locale === 'ko' ? `${base} 사본` : `${base} copy`;
    },
  };
}
