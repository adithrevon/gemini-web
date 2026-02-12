#!/bin/bash

# Clean up all persisted sessions and instances

PERSIST_DIR="$HOME/.gemini-web"
PERSIST_FILE="$PERSIST_DIR/sessions.json"

echo "🧹 Cleaning up backend sessions..."

if [ -f "$PERSIST_FILE" ]; then
    echo "Found: $PERSIST_FILE"
    echo "Size: $(du -h "$PERSIST_FILE" | cut -f1)"

    # Backup first
    BACKUP_FILE="$PERSIST_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$PERSIST_FILE" "$BACKUP_FILE"
    echo "✓ Backup created: $BACKUP_FILE"

    # Delete the file
    rm "$PERSIST_FILE"
    echo "✓ Deleted: $PERSIST_FILE"
    echo ""
    echo "All sessions cleared!"
    echo "Restart the backend server to start fresh."
else
    echo "✗ No sessions file found at: $PERSIST_FILE"
    echo "Nothing to clean."
fi
