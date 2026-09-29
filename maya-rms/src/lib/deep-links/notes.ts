/**
 * The one quiet line a link can ask for, from this fixed list only. The role
 * ones say what the server says when it refuses a save below the role;
 * "reconnected" is where a successful reconnect lands (lib/pms/oauth-flow.ts).
 */
export const NOTE_TEXT: Record<string, string> = {
  "role-rules": "Adding a rule needs Revenue Manager access or higher on this property.",
  "role-price": "Setting a price needs Revenue Manager access or higher on this property.",
  "role-suggestions": "Getting suggestions needs Revenue Manager access or higher on this property.",
  "entry-gone": "That change is no longer in the list shown here.",
  reconnected: "Reconnected.",
};
