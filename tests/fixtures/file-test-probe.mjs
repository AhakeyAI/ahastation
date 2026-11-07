// Process-recovery tests exercise the real Hub, durable identity and helper
// cleanup. Their only execution agent is file-test: discovering/authenticating
// installed personal CLIs adds windows and unrelated startup time to the test.
export function isolateFileTestProbe(service) {
  service.probe = async () => {
    service.probes = [{ agentId: 'file-test', installed: true, authenticated: true,
      executionModes: ['worker'], guide: 'isolated non-model fixture' }];
    await service.storage.update(state => {
      state.config.agents = [{ agentId: 'file-test', backendId: 'file-test',
        available: state.allowedAgents.includes('file-test'), executionModes: ['worker'] }];
    });
  };
}
