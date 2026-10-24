import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Language = 'zh' | 'en';

/** Options shown in Settings → General → Language, in native form. */
export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' },
];

interface LanguageState {
  language: Language;
  setLanguage: (language: Language) => void;
}

/**
 * Interface language, a client preference like the theme: it must apply
 * instantly and survive without the backend, so it lives in localStorage
 * rather than in `~/.pi/agent/settings.json`.
 */
export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: 'zh',
      setLanguage: (language) => set({ language }),
    }),
    { name: 'pi-language-storage' },
  ),
);
