#!/bin/bash
#
# smol-agent installer
# Installs smol-agent as a global CLI tool
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     smol-agent Installer                ║${NC}"
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

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if package.json exists
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: package.json not found${NC}"
    echo "Please run this script from the smol-agent project directory"
    exit 1
fi

echo ""
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install

echo ""
echo -e "${YELLOW}Linking smol-agent globally...${NC}"
npm link

# Check if the link was successful
if command -v smol-agent &> /dev/null; then
    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Installation successful!${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo "Run smol-agent with:"
    echo "  smol-agent                  # interactive mode"
    echo "  smol-agent \"your prompt\"   # one-shot mode"
    echo ""
    echo "Options:"
    echo "  -m, --model <name>   Ollama model to use"
    echo "  -H, --host <url>     Ollama server URL"
    echo "  --help               Show all options"
    echo ""
    echo "Prerequisites:"
    echo "  - Ollama running (default: http://127.0.0.1:11434)"
    echo "  - A model pulled: ollama pull qwen2.5-coder:7b"
else
    echo -e "${RED}Installation failed${NC}"
    echo "Try running: npm link"
    exit 1
fi
