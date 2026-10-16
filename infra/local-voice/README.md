# Local CPU voice

Optional Russian speech and recognition using ready-made [Piper](https://github.com/OHF-Voice/piper1-gpl) and [faster-whisper](https://github.com/SYSTRAN/faster-whisper) models. No hosted speech account, GPU, or runtime downloads. `orc-ru` is a lowered, bass-enhanced stylized voice, not an original game recording or a clone.

The Russian Dmitri model's dataset is CC0; its MODEL_CARD is bundled in the image. Piper is GPL-3.0; faster-whisper and Whisper are MIT. This optional service runs separately from the application.

Build with `docker compose --env-file /path/to/private.env -f compose.yaml build`, then start with `up -d`. The private environment file must contain a random `VOICE_API_TOKEN` of at least 32 characters. Do not commit that file. The service has no published port and runs on the internal `rakazo_voice` network with CPU/memory limits.

Attach the API service to that network and set its operator-only `VOICE_API_URL=http://voice:8000/v1`. The existing Voice settings then expose **Local voice**. Connect with the private sidecar token, select **Орк · русский**, and test a sample. The token uses the existing encrypted, user-scoped voice credential store. Other providers remain unchanged. No database migration is needed.

Models are built into the image: Piper `ru_RU-dmitri-medium` and Whisper `base` at the pinned repository revisions in `download_models.py`. Audio and text stay in memory. Transcription rejects recordings longer than 45 seconds; long recordings must be split by the caller. The existing call UI detects pauses and sends individual turns.

The catalog labels are `Local voice`, `Орк · русский`, and `Дмитрий · русский`. They identify the newly available provider and voices only within the existing settings and picker.

For an existing image-based installation, `api-overlay.yaml` mounts only the two changed adapter source files, without replacing the API image. Set `LOCAL_VOICE_ADAPTER_DIR` to the absolute deployment directory containing those files. Merge the overlay with the installation's existing Compose files and preserve its other overrides. A full source build including these changes does not need those two mounts. Keep the overlay with the deployment configuration for future container recreation.

Rollback: choose a previous voice provider, remove the API endpoint/network override, and stop the optional service. Preserve application and Postgres volumes. Windows Electron loads the same server UI, so it needs no separate binary patch.
