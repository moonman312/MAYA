// The docs and support pages can be light or dark (the reader picks, or the
// system does). The app's own screens have one look and never read the class.
export const THEME_KEY = "maya-theme";
// Sent whenever the class changes, so the theme toggle shows the right action.
export const THEME_EVENT = "maya:theme-change";
export const THEMED_PATHS = /^\/(docs|support)(\/|$)/;

// Runs in the <head> before the page paints (see ThemeScript), so a
// light-mode reader of the docs never sees a dark flash. Anywhere else it
// takes the class off. Keep it tiny and dependency-free.
export const THEME_SCRIPT = `try{var d=false;if(/^\\/(docs|support)(\\/|$)/.test(location.pathname)){var t=localStorage.getItem("${THEME_KEY}");d=t?t==="dark":!matchMedia("(prefers-color-scheme: light)").matches}document.documentElement.classList.toggle("dark",d)}catch(e){}`;
