// Voice catalogue across the TTS models Cloudflare exposes.

export type TtsModel =
  | '@cf/deepgram/aura-1'
  | '@cf/deepgram/aura-2-en'
  | '@cf/deepgram/aura-2-es'
  | 'google/gemini-3.1-flash-tts';

export interface ModelMeta {
  id: TtsModel;
  label: string;
  vendor: string;
  description: string;
  pricing?: string;
}

export const MODELS: ModelMeta[] = [
  {
    id: '@cf/deepgram/aura-2-en',
    label: 'Aura-2 · English',
    vendor: 'Deepgram',
    description: 'HD English · 40 voices',
    pricing: '≈ $0.022 / spoken min',
  },
  {
    id: '@cf/deepgram/aura-2-es',
    label: 'Aura-2 · Spanish',
    vendor: 'Deepgram',
    description: 'HD Spanish · 10 voices',
    pricing: '≈ $0.022 / spoken min',
  },
  {
    id: 'google/gemini-3.1-flash-tts',
    label: 'Gemini Flash',
    vendor: 'Google',
    description: 'Multilingual · 30 voices',
    pricing: 'BYOK · Google AI Studio',
  },
  {
    id: '@cf/deepgram/aura-1',
    label: 'Aura-1 · Legacy',
    vendor: 'Deepgram',
    description: 'Original lineup · 12 voices · English',
    pricing: '≈ $0.011 / spoken min',
  },
];

export interface VoiceMeta {
  id: string;
  label: string;
  gender?: 'female' | 'male';
  languages: string[];
  model: TtsModel;
  description?: string;
  hd?: boolean;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

// --- Aura-1 (legacy English) ---
const AURA1: VoiceMeta[] = [
  { id: 'asteria', label: 'Asteria', gender: 'female', languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Warm' },
  { id: 'luna',    label: 'Luna',    gender: 'female', languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Soft' },
  { id: 'stella',  label: 'Stella',  gender: 'female', languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Bright' },
  { id: 'athena',  label: 'Athena',  gender: 'female', languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Composed' },
  { id: 'hera',    label: 'Hera',    gender: 'female', languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Confident' },
  { id: 'orion',   label: 'Orion',   gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Calm' },
  { id: 'arcas',   label: 'Arcas',   gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Natural' },
  { id: 'perseus', label: 'Perseus', gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Deep' },
  { id: 'angus',   label: 'Angus',   gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Scottish' },
  { id: 'orpheus', label: 'Orpheus', gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Smooth' },
  { id: 'helios',  label: 'Helios',  gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Energetic' },
  { id: 'zeus',    label: 'Zeus',    gender: 'male',   languages: ['en-US'], model: '@cf/deepgram/aura-1', description: 'Bold' },
];

// --- Aura-2 English (HD, 40 voices) ---
const AURA2_EN_FEMALE = [
  'amalthea','andromeda','asteria','athena','aurora','callista','cora','cordelia','delia',
  'electra','harmonia','helena','hera','iris','juno','luna','minerva','ophelia','pandora',
  'phoebe','thalia','theia','vesta',
] as const;
const AURA2_EN_MALE = [
  'apollo','arcas','aries','atlas','draco','hermes','hyperion','janus','jupiter','mars',
  'neptune','odysseus','orion','orpheus','pluto','saturn','zeus',
] as const;
const AURA2_EN: VoiceMeta[] = [
  ...AURA2_EN_FEMALE.map<VoiceMeta>((s) => ({
    id: `aura2en:${s}`, label: cap(s), gender: 'female',
    languages: ['en-US'], model: '@cf/deepgram/aura-2-en', hd: true,
  })),
  ...AURA2_EN_MALE.map<VoiceMeta>((s) => ({
    id: `aura2en:${s}`, label: cap(s), gender: 'male',
    languages: ['en-US'], model: '@cf/deepgram/aura-2-en', hd: true,
  })),
];

// --- Aura-2 Spanish (10 voices) ---
const AURA2_ES_FEMALE = ['carina', 'celeste', 'diana', 'selena', 'estrella'] as const;
const AURA2_ES_MALE = ['sirio', 'nestor', 'alvaro', 'aquila', 'javier'] as const;
const AURA2_ES: VoiceMeta[] = [
  ...AURA2_ES_FEMALE.map<VoiceMeta>((s) => ({
    id: `aura2es:${s}`, label: cap(s), gender: 'female',
    languages: ['es'], model: '@cf/deepgram/aura-2-es', hd: true,
  })),
  ...AURA2_ES_MALE.map<VoiceMeta>((s) => ({
    id: `aura2es:${s}`, label: cap(s), gender: 'male',
    languages: ['es'], model: '@cf/deepgram/aura-2-es', hd: true,
  })),
];

// --- Gemini Flash (30 voices, multilingual). Gender omitted — Google doesn't publish per-voice gender. ---
const GEMINI_NAMES = [
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe',
  'Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi',
  'Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi',
  'Vindemiatrix','Sadachbia','Sadaltager','Sulafat',
] as const;
const GEMINI: VoiceMeta[] = GEMINI_NAMES.map((n) => ({
  id: `gemini:${n}`,
  label: n,
  languages: ['multi'],
  model: 'google/gemini-3.1-flash-tts',
  hd: true,
}));

export const VOICES: VoiceMeta[] = [...AURA2_EN, ...AURA2_ES, ...GEMINI, ...AURA1];

export const LANGUAGE_LABELS: Record<string, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  es: 'Spanish',
  'es-ES': 'Spanish (Spain)',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  hi: 'Hindi',
  ja: 'Japanese',
  zh: 'Chinese',
  multi: 'Multilingual',
};

export function voiceById(id: string): VoiceMeta | undefined {
  return VOICES.find((v) => v.id === id);
}
export function modelById(id: string): ModelMeta | undefined {
  return MODELS.find((m) => m.id === id);
}
export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}
