#!/bin/bash
#
# smol-agent installer
# Installs smol-agent as a global CLI tool
#
# Usage:
#   From GitHub (recommended):
#     curl -fsSL https://raw.githubusercontent.com/streed/smol-agent/main/install.sh | sh
#
#   Or from within the cloned repo:
#     ./install.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

REPO_URL="https://github.com/streed/smol-agent.git"
RELEASES_API="https://api.github.com/repos/streed/smol-agent/releases"

# XDG-compliant install locations
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
INSTALL_DIR="$XDG_DATA_HOME/smol-agent"
CONFIG_DIR="$XDG_CONFIG_HOME/smol-agent"

# Store install location for self-update
INSTALL_MARKER="$CONFIG_DIR/install-info"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     smol-agent Installer               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Please install Node.js >= 18 from https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js version must be >= 18${NC}"
    echo "Current version: $(node -v)"
    exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node -v) detected"

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} npm $(npm -v) detected"

# Check if git is available (needed for cloning and updates)
if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: git is not installed${NC}"
    echo "Please install git from https://git-scm.com/"
    exit 1
fi

echo -e "${GREEN}✓${NC} git $(git --version | cut -d' ' -f3) detected"

# Check if curl is available (needed for version checking)
if ! command -v curl &> /dev/null; then
    echo -e "${RED}Error: curl is not installed${NC}"
    exit 1
fi

# Function to get latest release version from GitHub API
get_latest_version() {
    # Try to get the latest release version from GitHub API
    LATEST_VERSION=$(curl -fsSL "$RELEASES_API/latest" 2>/dev/null | grep -m1 '"tag_name"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\?\([^"]*\)".*/\1/' || echo "")
    
    if [ -z "$LATEST_VERSION" ]; then
        # Fallback: try to get version from package.json in main branch
        LATEST_VERSION=$(curl -fsSL "https://raw.githubusercontent.com/streed/smol-agent/main/package.json" 2>/dev/null | grep '"version"' | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo "")
    fi
    
    echo "$LATEST_VERSION"
}

# Determine if we're running from within the repo or via curl
if [ -f "package.json" ] && grep -q '"name": "smol-agent"' package.json 2>/dev/null; then
    # Running from within the repo - get the repo root
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"
    cd "$REPO_ROOT"
    INSTALL_TYPE="git-clone"
    INSTALL_SOURCE="$REPO_ROOT"
    echo -e "${GREEN}✓${NC} Running from existing smol-agent directory: $REPO_ROOT"
else
    # Running via curl | sh or from outside the repo
    INSTALL_TYPE="curl-sh"
    INSTALL_SOURCE="$INSTALL_DIR"
    
    echo ""
    echo -e "${YELLOW}Fetching latest release version...${NC}"
    
    # Get latest version
    LATEST_VERSION=$(get_latest_version)
    
    if [ -n "$LATEST_VERSION" ]; then
        echo -e "${GREEN}✓${NC} Latest version: v$LATEST_VERSION"
        VERSION_TAG="v$LATEST_VERSION"
    else
        echo -e "${YELLOW}Warning: Could not determine latest version, using main branch${NC}"
        VERSION_TAG="main"
    fi
    
    echo ""
    echo -e "${YELLOW}Cloning smol-agent...${NC}"
    
    # Create XDG data directory if it doesn't exist
    mkdir -p "$XDG_DATA_HOME"
    
    # Remove old installation if it exists
    if [ -d "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}Removing previous installation...${NC}"
        rm -rf "$INSTALL_DIR"
    fi
    
    # Clone the repository at the specific version
    if [ "$VERSION_TAG" != "main" ]; then
        git clone --depth 1 --branch "$VERSION_TAG" "$REPO_URL" "$INSTALL_DIR"
    else
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
    echo -e "${GREEN}✓${NC} Cloned to $INSTALL_DIR"
fi

echo ""
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install

echo ""
echo -e "${YELLOW}Linking smol-agent globally...${NC}"
npm link

# Save install info for self-update
mkdir -p "$CONFIG_DIR"
cat > "$INSTALL_MARKER" << EOF
INSTALL_TYPE=$INSTALL_TYPE
INSTALL_SOURCE=$INSTALL_SOURCE
INSTALL_DIR=$INSTALL_DIR
INSTALLED_AT=$(date -Iseconds)
INSTALLED_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
EOF

# Check if the link was successful
if command -v smol-agent &> /dev/null; then
    INSTALLED_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
    
    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Installation successful!                ${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo "  Version: v$INSTALLED_VERSION"
    echo ""
    echo "Run smol-agent with:"
    echo "  smol-agent                  # interactive mode"
    echo "  smol-agent \"your prompt\"    # one-shot mode"
    echo ""
    echo "Options:"
    echo "  -m, --model <name>   Ollama model to use"
    echo "  -H, --host <url>     Ollama server URL"
    echo "  --help               Show all options"
    echo "  --self-update        Update smol-agent to latest version"
    echo ""
    echo "Prerequisites:"
    echo "  - Ollama running (default: http://127.0.0.1:11434)"
    echo "  - A model pulled: ollama pull qwen2.5-coder:7b"
    echo ""
    echo "Installed to: $INSTALL_DIR"
    echo "To update: smol-agent --self-update"
else
    echo -e "${RED}Installation failed${NC}"
    echo "Try running: npm link"
    exit 1
fi