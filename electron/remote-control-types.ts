export interface RemoteControlSettings {
  enabled: boolean;
  mode: 'public' | 'legacy';
  serviceUrl: string;
  login?: string;
  ownerId?: string;
  controlToken?: string; // Main-process memory only.
  controlTokenEnc?: string;
  credentialInvalid?: boolean;
  pendingSubmissions?: Record<string, string>;
}
export interface RemoteControlView {
  enabled: boolean;
  mode: 'public' | 'legacy';
  serviceUrl: string;
  login?: string;
  ownerId?: string;
  loggedIn: boolean;
  securePersistence: boolean;
}
export interface RemoteDeviceView {
  id: string;
  name: string;
  online: boolean;
  agents?: Array<{ agent_id: string; display_name: string; status: string }>;
}
export interface RemoteTaskView {
  task_id: string;
  status: string;
  target_agent?: string;
  session_id?: string;
  error?: string;
  result?: { cleanup_confirmed?: boolean; cancelled?: boolean };
}
export interface RemoteControlReply {
  ok: boolean;
  error?: string;
  settings?: RemoteControlView;
  devices?: RemoteDeviceView[];
  tasks?: RemoteTaskView[];
  pair_code?: string;
  expires_in?: number;
}
