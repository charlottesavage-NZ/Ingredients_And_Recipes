// -------------------------------------------------------------
// The "Removed Rice - Undo" message that pops up at the bottom of
// the screen for a few seconds after any change to the house stock
// (Inventory page AND "I made this" on the Recipes page - both pages
// load this file).
//
// The server keeps a copy of things from just before the change,
// and clicking Undo asks it to put that copy back. Only the most
// recent change can be undone - see the UNDO section in server.js.
// -------------------------------------------------------------

// How long the message stays up before it disappears, in milliseconds.
const UNDO_TOAST_SECONDS = 8;

let undoToastTimer = null;

// Shows the message. onUndone() is called after a successful undo,
// so the page can reload whatever it's showing.
function showUndoToast(message, undoId, onUndone) {
    // Only one message at a time - a new change replaces the old one
    // (and the old one couldn't be undone any more anyway).
    let toast = document.getElementById('undo-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'undo-toast';
        // role="status" makes screen readers read the message out.
        toast.setAttribute('role', 'status');
        document.body.appendChild(toast);
    }

    toast.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    if (undoId) {
        const undoButton = document.createElement('button');
        undoButton.type = 'button';
        undoButton.textContent = 'Undo';
        undoButton.addEventListener('click', () => {
            undoButton.disabled = true;
            fetch('/recipes/undo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ undoId })
            })
                .then(response => {
                    if (response.status === 409) {
                        showUndoToast("Too late to undo - something else has changed since.", null);
                        return;
                    }
                    if (!response.ok) throw new Error('Server said ' + response.status);
                    showUndoToast('Undone.', null);
                    if (onUndone) onUndone();
                })
                .catch(error => {
                    console.error('Could not undo:', error);
                    showUndoToast("Couldn't undo - try again in a moment.", null);
                });
        });
        toast.appendChild(undoButton);
    }

    toast.hidden = false;
    clearTimeout(undoToastTimer);
    undoToastTimer = setTimeout(() => { toast.hidden = true; }, UNDO_TOAST_SECONDS * 1000);
}
