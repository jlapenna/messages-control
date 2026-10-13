# Messages Control

Filter spam and organize messages in Google Messages with an AI classifier
of your choice. Messages Control pairs with your Android phone through
Google Messages for web and runs as a standalone CLI or a Chrome extension.

- Block and report spam, or delete it instead.
- Delete marketing conversations and optionally send a STOP reply.
- Review activity in a dashboard, undo blocks and archives, and generate digests.

**Experimental:** Messages Control automates the Google Messages web interface.
Changes to that interface can break it, and classification can make mistakes.
Deleted conversations cannot be restored.

## Get started

You need an Android phone using Google Messages, Node.js 24, a desktop window
for initial pairing, and an OpenAI-compatible chat-completions endpoint.
Choose a vision-capable model if you want it to classify pictures. The
standalone CLI is tested on Linux.

1. Install the CLI and its browser:

   ```sh
   git clone https://github.com/jlapenna/messages-control.git
   cd messages-control
   npm ci
   npx playwright install chromium
   npm link
   ```

   On Linux systems missing browser libraries, use
   `npx playwright install --with-deps chromium`.

2. Configure your endpoint, model and API key:

   ```sh
   messages-control init
   ```

3. Pair with your phone. Sign in with the phone's Google account in the
   browser window and approve pairing on your phone:

   ```sh
   messages-control pair --headed
   ```

4. Start in dry run and review the proposed actions:

   ```sh
   messages-control run
   ```

   Open [the dashboard](http://127.0.0.1:7373/) while the watcher is running.
   Its access token is generated on the first run and saved as `api.token` in
   `~/.config/messages-control/config.json`. You can also inspect activity
   with `messages-control log`.

5. After reviewing the results, stop the watcher with Ctrl+C and enable
   automatic blocking and deletion:

   ```sh
   messages-control run --live
   ```

## What gets processed?

| Mode | Behavior |
| --- | --- |
| `spam` (default) | Classify new threads; block and report spam, delete marketing, keep other messages. |
| `full` | Also classify existing threads and archive one-time codes after 6 hours and automated notices after 24 hours. |

Use `--mode full` to select full mode. Dry run prevents blocking and deletion;
it still permits full-mode archiving. Opening picture threads can mark them
read and send RCS read receipts in either mode.

A new thread is judged only once its message has arrived. If the open
conversation shows no message text and no picture (for example, only the
"Texting with…" banner while an MMS downloads), or a picture message's
picture is not retrieved yet, the thread stays new and is looked at again on
the next scan. After three looks it is judged with whatever has loaded.

Automatic classification skips names without digits or `@` by default. This
is a name heuristic, not a lookup in your contacts. Change `skipNamedContacts`
to control it.

The dashboard's **View message** action shows the saved preview and reason
before offering **Undo block** or **Unarchive**. Previews contain up to 500
characters, not the full conversation or attachments. Use Google Messages
when you need the full conversation or an older event has no saved preview.

## Chrome extension

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select this repository. In the extension's options, enter your endpoint,
model and API key, then click **Save** and grant access to the endpoint's host.
Use HTTPS for remote endpoints. Pair Google Messages in the same Chrome profile.

The extension uses the same classification settings and rules. The local
web dashboard, CLI, service and digest features belong to the standalone runner.

## Privacy and data

Message text, sender names and enabled pictures are sent to your configured
AI provider. Its privacy and retention terms apply. Block & report sends
information to Google; optional STOP replies, notifications and digests send
data to their configured recipients.

Configuration contains credentials. The standalone runner stores its browser
profile, message state and activity previews under `~/.local/state/messages-control/`.
The extension stores its settings in your Chrome profile.
Protect those files and their backups. Do not put real messages, keys or
browser profiles in bug reports. See [SECURITY.md](SECURITY.md) for private
vulnerability reporting.

## More

| Guide | Contents |
| --- | --- |
| [Usage guide](docs/usage.md) | Commands, settings, policies, notifications, API and monitoring. |
| [Run as a service](docs/usage.md#running-as-a-service) | Background operation and pairing recovery. |
| [Docker and desktop](docs/usage.md#docker) | Alternative ways to run the standalone app. |
| [Contributing](CONTRIBUTING.md) | Development setup, tests and source layout. |

Licensed under the [MIT License](LICENSE).
