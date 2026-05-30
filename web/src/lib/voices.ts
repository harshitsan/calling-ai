export interface VoiceMeta {
  id: string;
  label: string;
  gender: 'female' | 'male';
  /** BCP-47 codes the voice supports. Single entry = locked to that language. */
  languages: string[];
  description?: string;
}

export const VOICES: VoiceMeta[] = [
  { id: 'asteria', label: 'Asteria', gender: 'female', languages: ['en-US'], description: 'Warm' },
  { id: 'luna',    label: 'Luna',    gender: 'female', languages: ['en-US'], description: 'Soft' },
  { id: 'stella',  label: 'Stella',  gender: 'female', languages: ['en-US'], description: 'Bright' },
  { id: 'athena',  label: 'Athena',  gender: 'female', languages: ['en-US'], description: 'Composed' },
  { id: 'hera',    label: 'Hera',    gender: 'female', languages: ['en-US'], description: 'Confident' },
  { id: 'orion',   label: 'Orion',   gender: 'male',   languages: ['en-US'], description: 'Calm' },
  { id: 'arcas',   label: 'Arcas',   gender: 'male',   languages: ['en-US'], description: 'Natural' },
  { id: 'perseus', label: 'Perseus', gender: 'male',   languages: ['en-US'], description: 'Deep' },
  { id: 'angus',   label: 'Angus',   gender: 'male',   languages: ['en-US', 'en-GB'], description: 'Scottish' },
  { id: 'orpheus', label: 'Orpheus', gender: 'male',   languages: ['en-US'], description: 'Smooth' },
  { id: 'helios',  label: 'Helios',  gender: 'male',   languages: ['en-US'], description: 'Energetic' },
  { id: 'zeus',    label: 'Zeus',    gender: 'male',   languages: ['en-US'], description: 'Bold' },
];

export const LANGUAGE_LABELS: Record<string, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'es-ES': 'Spanish (Spain)',
  'es-LA': 'Spanish (Latin America)',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  hi: 'Hindi',
  ja: 'Japanese',
  zh: 'Chinese',
};

export function voiceById(id: string): VoiceMeta | undefined {
  return VOICES.find((v) => v.id === id);
}

export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}
