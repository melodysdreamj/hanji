import { i18next, initI18n } from "@/i18n";

// Production initializes every catalog before mounting React. Unit tests must
// exercise the same contract; otherwise translations resolve to undefined/raw
// keys and component behavior, accessible names, and error messages are tested
// against a state users never see.
await initI18n();
await i18next.changeLanguage("en");
