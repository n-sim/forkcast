const defaultRecipePrompt =
  'Use English and metric quantities. Prefer practical home cooking.';

function promptKey(owner: string) {
  return `forkcast-ai-prompts:${owner}`;
}

export function loadRecipePrompt(owner: string): string {
  return localStorage.getItem(promptKey(owner)) ?? defaultRecipePrompt;
}

export function saveRecipePrompt(owner: string, prompt: string) {
  localStorage.setItem(promptKey(owner), prompt);
}
