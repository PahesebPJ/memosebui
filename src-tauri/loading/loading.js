// The native shell navigates back here with ?error=<message> when the sidecar fails.
const message = new URLSearchParams(window.location.search).get('error')
if (message) {
  document.getElementById('status').textContent = 'No se pudo iniciar el visor neuronal.'
  const error = document.getElementById('error')
  error.textContent = message
  error.hidden = false
}
