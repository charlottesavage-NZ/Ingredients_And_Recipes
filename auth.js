// -------------------------------------------------------------
// Login check - loaded at the very top of every page (in <head>),
// BEFORE the page's own script.
//
// It asks the server "who's logged in on this browser?". If the
// answer is "nobody" (a 401 reply), it sends you to login.html, and
// remembers which page you were trying to open so you land back on
// it after logging in. See the LOGIN section in server.js.
// -------------------------------------------------------------

// While the check is happening, the page is hidden (see the
// .checking-login rule in style.css), so you don't see a flash of
// an empty page before being sent to the login screen.
document.documentElement.classList.add('checking-login');

fetch('/recipes/whoami')
    .then(response => {
        if (response.status === 401) {
            // e.g. "recipes.html" - the page to come back to afterwards.
            const thisPage = location.pathname.split('/').pop() || 'index.html';
            location.href = `login.html?next=${encodeURIComponent(thisPage)}`;
            return;
        }
        document.documentElement.classList.remove('checking-login');
    })
    .catch(() => {
        // The server couldn't be reached at all (rather than saying
        // "not logged in") - show the page anyway, so a hiccup never
        // locks you out completely. Nothing loads without the server
        // anyway.
        document.documentElement.classList.remove('checking-login');
    });
