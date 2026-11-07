import {getBackendRegistry} from '../../dist-electron/backends/registry.js';

// Integration fixtures exercise Station transport and journals, not provider
// login. Native CLIs can read OS credentials even with an isolated HOME.
// Tests that exercise login explicitly instantiate/inject their own backend.
for (const backend of getBackendRegistry().list()) {
  if (backend.checkAuthStatus) backend.checkAuthStatus = async () => ({loggedIn: false});
}
