import { useEffect, useState } from 'react';
import { subscribeToTopics } from './core';
import {
  aiModels,
  aiStatus,
  loadAiPreferences,
  type AiModel,
  type AiStatus,
} from './ai-client';

export interface AiModelChoice {
  loaded: boolean;
  connection: AiStatus | null;
  models: AiModel[];
  /** The model saved in Settings, if any. */
  saved: string | null;
  /** The model AI requests use: the saved one, else the first available. */
  model: string;
  /** The saved model, when the provider no longer offers it. */
  missing: string | null;
  /** AI requests can run: connected, and the saved model still exists. */
  ready: boolean;
  error: string;
}

/** The connection and the model chosen in Settings, for every AI workflow. */
export function useAiModel(enabled: boolean): AiModelChoice {
  const [choice, setChoice] = useState<AiModelChoice>({
    loaded: false,
    connection: null,
    models: [],
    saved: null,
    model: '',
    missing: null,
    ready: false,
    error: '',
  });
  // Connecting or signing out of ChatGPT changes what can be offered.
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    return subscribeToTopics(['ai'], () => setReloads((count) => count + 1));
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      try {
        const connection = await aiStatus();
        if (!active) return;
        if (connection.state !== 'connected') {
          setChoice((current) => ({
            ...current,
            loaded: true,
            connection,
            error: connection.message ?? '',
          }));
          return;
        }
        const [models, preferences] = await Promise.all([
          aiModels(),
          loadAiPreferences(),
        ]);
        if (!active) return;
        const saved = preferences.recipeModel;
        const available = models.some((entry) => entry.slug === saved);
        const model = available ? saved! : saved ? '' : (models[0]?.slug ?? '');
        setChoice({
          loaded: true,
          connection,
          models,
          saved,
          model,
          missing: saved && !available ? saved : null,
          ready: model !== '',
          error: models.length
            ? ''
            : 'No ChatGPT models are available for this account. Check your connection in Settings.',
        });
      } catch (failure) {
        if (active)
          setChoice((current) => ({
            ...current,
            loaded: true,
            error:
              failure instanceof Error
                ? failure.message
                : 'Could not load ChatGPT models.',
          }));
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, reloads]);
  return choice;
}

/** Explains, next to an AI button, that the model saved in Settings is gone. */
export function AiModelNotice({ choice }: { choice: AiModelChoice }) {
  if (!choice.missing) return null;
  return (
    <p
      className="nutrition-version-notice"
      role="status"
      aria-label="AI model unavailable"
    >
      Your saved ChatGPT model “{choice.missing}” is no longer available. Choose
      another model in <a href="#/settings">Settings</a>.
    </p>
  );
}
