/**
 * Starting a room-composite recording, behind a port (T28, R17).
 *
 * The seam exists for the reason `MediaTokenMinter`'s does: when a recording
 * should start, and what happens when it cannot, are worth testing without an
 * egress container — and there is exactly one place that knows how LiveKit is
 * asked.
 *
 * **The Control API never touches the recording.** It asks LiveKit to record,
 * and the egress container writes the file to object storage itself. Video does
 * not pass through this process (I6), which is why the S3 credentials here are
 * handed onward rather than used.
 */

import { Inject, Injectable } from '@nestjs/common';
import { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk';
import type { LiveKitConfig } from './livekit.config.js';
import { InjectLiveKitConfig } from './livekit.config.js';
import type { RecordingConfig } from './recording.config.js';
import { InjectRecordingConfig } from './recording.config.js';
import { RECORDING_LAYOUT, recordingKeyFor } from './recording.rules.js';

/** What a started recording reports back. */
export interface StartedRecording {
  /** LiveKit's own id. T38 fetches the file by it, so it must be recorded. */
  readonly egressId: string;
  /** The key the file will land under, derived from the session id. */
  readonly key: string;
}

export interface RecordingStarter {
  /**
   * Begin recording a room.
   *
   * Throws if LiveKit refuses — most often because the room does not exist,
   * which is what happens when nobody has joined it yet.
   */
  start(roomName: string, sessionId: string): Promise<StartedRecording>;
}

export const RECORDING_STARTER = Symbol('RECORDING_STARTER');

export const InjectRecordingStarter = (): ParameterDecorator => Inject(RECORDING_STARTER);

/**
 * LiveKit's HTTP address, from the URL the browsers connect to.
 *
 * The SDK's egress client speaks HTTP to the same host that serves the
 * WebSocket. Deriving it means one configured address rather than two that
 * could drift apart.
 */
export function httpUrlFrom(websocketUrl: string): string {
  return websocketUrl.replace(/^ws/, 'http');
}

@Injectable()
export class LiveKitRecordingStarter implements RecordingStarter {
  private readonly egress: EgressClient;

  constructor(
    @InjectLiveKitConfig() config: LiveKitConfig,
    @InjectRecordingConfig() private readonly storage: RecordingConfig,
  ) {
    this.egress = new EgressClient(httpUrlFrom(config.url), config.apiKey, config.apiSecret);
  }

  async start(roomName: string, sessionId: string): Promise<StartedRecording> {
    const key = recordingKeyFor(sessionId);

    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      // A literal key, not LiveKit's `{room_name}-{time}` template: T38 has to
      // find this file from the session id alone.
      filepath: key,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: this.storage.accessKeyId,
          secret: this.storage.secretAccessKey,
          region: this.storage.region,
          // The address the *egress container* uploads through, which is not
          // necessarily the one this process uses. See `recording.config.ts`.
          endpoint: this.storage.egressEndpoint,
          bucket: this.storage.bucket,
          forcePathStyle: this.storage.forcePathStyle,
        }),
      },
    });

    const info = await this.egress.startRoomCompositeEgress(roomName, output, {
      layout: RECORDING_LAYOUT,
    });

    return { egressId: info.egressId, key };
  }
}
