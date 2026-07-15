declare module '@stremio/stremio-video' {
  interface StremioVideoTrack {
    id: string;
    label?: string;
    language?: string;
    default?: boolean;
  }

  interface StremioVideoSource {
    url: string;
    autoplay?: boolean;
    subtitles?: Array<{
      url: string;
      lang: string;
      label?: string;
    }>;
  }

  interface StremioVideoEventDefinitions {
    error: (error: any) => void;
    loading: (isLoading: boolean) => void; // Assuming loading passes a boolean
    loaded: () => void;
    ended: () => void;
    propChanged: (propName: string, propValue: any) => void;
    propValue: (propName: string, propValue: any) => void; // Saw this in useVideo.js
    audioTracksChanged: () => void;
    subtitleTracksChanged: () => void;
    subtitlesTrackLoaded: (track: any) => void; // Saw this in useVideo.js
    extraSubtitlesTrackLoaded: (track: any) => void; // Saw this in useVideo.js
    extraSubtitlesTrackAdded: (track: any) => void; // Saw this in useVideo.js
    implementationChanged: (manifest: any) => void; // Saw this in useVideo.js
    timeUpdate: (currentTime: number) => void; // Keep if it exists, or handle via propChanged for 'time'
    // Add other events as discovered or needed
  }

  type EventName = keyof StremioVideoEventDefinitions;

  interface DispatchAction {
    type: 'command' | 'setProp' | 'observeProp';
    commandName?: string;
    commandArgs?: any;
    propName?: string;
    propValue?: any;
  }

  interface DispatchOptions {
    containerElement?: HTMLElement;
    // Add other potential options
  }

  class StremioVideo {
    constructor(); // No arguments

    // Properties (these are likely accessed via state updated by 'propChanged')
    // It might be better to rely on state managed by events rather than direct property access
    // For now, keeping them as potentially readable if the library updates them directly too.
    readonly audioTracks: StremioVideoTrack[];
    readonly subtitleTracks: StremioVideoTrack[];
    readonly duration: number; // via propChanged
    readonly currentTime: number; // via propChanged
    selectedAudioTrackId: string | null; // set via setProp, read via propChanged
    selectedSubtitleTrackId: string | null; // set via setProp, read via propChanged
    muted: boolean; // set via setProp, read via propChanged
    volume: number; // set via setProp, read via propChanged
    paused: boolean; // set via setProp, read via propChanged
    playbackSpeed: number; // set via setProp, read via propChanged

    // Methods
    dispatch(action: DispatchAction, options?: DispatchOptions): void;
    destroy(): void; // Changed from Promise<void> to void

    on<K extends EventName>(event: K, callback: StremioVideoEventDefinitions[K]): void;
    on(event: string, callback: (...args: any[]) => void): void; // Fallback
    off<K extends EventName>(event: K, callback: StremioVideoEventDefinitions[K]): void; // Typically paired with on
    off(event: string, callback: (...args: any[]) => void): void; // Fallback
  }

  export default StremioVideo;
} 