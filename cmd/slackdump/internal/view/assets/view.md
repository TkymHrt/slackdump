# View Command

The `view` command allows you to view the contents of an archive,
export, or dump directory or ZIP file.

The live viewer loads channel history in pages and renders only visible
messages. It has a thread panel, user profiles, channel filtering, and search
across channel and thread messages. Search results open the matching message.
The viewer remembers your place in a conversation during navigation.

Downloaded images, videos, and canvas files are displayed when available.
The canvas frame does not run scripts. The viewer supports light and dark
themes and narrow screens.

The viewer does not edit archived messages. Writable SQLite archives can store
channel aliases and may receive schema migrations when opened; other archive
formats remain read-only.

## Usage

```bash
slackdump view <directory_or_file>
```

Press `/` to focus message search. Use the sidebar field to filter conversation
names. Open an older message link directly to restore its place in the archive.

If you experience problems viewing, run the viewer with DEBUG mode
enabled, and report the violating message to the GitHub Issues page.

```bash
DEBUG=1 slackdump view <directory_or_file>
```

It is recommended that you remove all sensitive information from the
JSON before sharing it, and also, to encrypt your message, you can use
the `slackdump tools encrypt` command, for example:

```bash
cat your_message.txt | slackdump tools encrypt > encrypted_message.txt
```

This will encrypt it using the embedded GPG public key, and can only be
encrypted by the author.
