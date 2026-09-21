import { SupabaseModel } from './base.js';

const UserSettings = new SupabaseModel('user_settings', {
  allColumns: [
    'id', 'user_id', 'theme', 'language', 'voice_id', 'voice_speed',
    'auto_play_voice', 'enter_to_send', 'show_timestamps', 'streaming_enabled',
    'memory_enabled', 'created_at', 'updated_at',
  ],
  defaults: {
    theme: 'dark',
    language: 'en',
    voiceId: 'alloy',
    voiceSpeed: 1,
    autoPlayVoice: false,
    enterToSend: true,
    showTimestamps: true,
    streamingEnabled: true,
    memoryEnabled: true,
  },
});

export default UserSettings;