/**
 * The one quiet line a link can ask for, from this fixed list only. They say
 * what the server says when it refuses a save below the role.
 */
export const NOTE_TEXT: Record<string, string> = {
  "role-rules": "Adding a rule needs Revenue Manager access or higher on this property.",
  "role-price": "Setting a price needs Revenue Manager access or higher on this property.",
  "role-suggestions": "Getting suggestions needs Revenue Manager access or higher on this property.",
  "entry-gone": "That change is no longer in the list shown here.",
};
