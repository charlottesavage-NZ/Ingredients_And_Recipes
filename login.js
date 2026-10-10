// -------------------------------------------------------------
// The login screen. Sends the username and password to the server
// (POST /recipes/login - see the LOGIN section in server.js). If
// they match, the server remembers this browser with a cookie and
// we head back to whichever page you were trying to open.
// -------------------------------------------------------------
const SERVER_URL = '/recipes';

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

// The page to go back to after logging in - auth.js adds it to the
// address as ?next=recipes.html. Only our own three pages are
// allowed, so a dodgy link can't use this to send you off to some
// other website after you log in.
const ALLOWED_PAGES = ['index.html', 'recipes.html', 'price-checker.html'];
const requestedPage = new URLSearchParams(location.search).get('next');
const nextPage = ALLOWED_PAGES.includes(requestedPage) ? requestedPage : 'index.html';

loginForm.addEventListener('submit', function(event) {
    event.preventDefault();
    loginError.textContent = '';

    fetch(`${SERVER_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: document.getElementById('login-username').value,
            password: document.getElementById('login-password').value
        })
    })
        .then(response => {
            if (response.status === 401) {
                loginError.textContent = 'Wrong username or password - try again.';
                return;
            }
            if (!response.ok) throw new Error('Server said ' + response.status);

            // Logged in - the cookie's been saved, so go to the page.
            location.href = nextPage;
        })
        .catch(error => {
            console.error('Could not log in:', error);
            loginError.textContent = "Couldn't reach the server - try again in a moment.";
        });
});
