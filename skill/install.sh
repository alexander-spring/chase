#!/bin/bash
# Chase Skill Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/alexander-spring/chase/main/skill/install.sh | bash

set -e

SKILL_DIR="$HOME/.claude/skills/chase"
SKILL_URL="https://raw.githubusercontent.com/alexander-spring/chase/main/skill/SKILL.md"

echo "Installing Chase skill for Claude Code..."

# Create directory
mkdir -p "$SKILL_DIR"

# Download skill
curl -fsSL "$SKILL_URL" -o "$SKILL_DIR/SKILL.md"

echo ""
echo "✓ Skill installed to $SKILL_DIR/SKILL.md"
echo ""
echo "Next steps:"
echo "  1. Set your API key:  export BROWSER_CASH_API_KEY=\"your-key\""
echo "  2. Get an API key at: https://browser.cash"
echo ""
echo "Usage in Claude Code:"
echo "  Just ask Claude to extract data from any website!"
echo ""
