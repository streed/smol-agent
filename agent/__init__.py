"""
Agent module - Core agent functionality with event-driven architecture.

This module provides:
- EventEmitter: Observer pattern implementation for state changes
- AgentEventType: Enumeration of all event types
- Event dataclasses: Structured event data for each type
- Agent: Core agent that emits events during lifecycle
"""

from .events import (
    EventEmitter,
    AgentEventType,
    AgentEvent,
    AgentStartEvent,
    AgentStopEvent,
    ThinkingEvent,
    ToolUseEvent,
    OutputEvent,
    ErrorEvent,
)
from .core import Agent

__all__ = [
    # Events module
    "EventEmitter",
    "AgentEventType",
    "AgentEvent",
    "AgentStartEvent",
    "AgentStopEvent",
    "ThinkingEvent",
    "ToolUseEvent",
    "OutputEvent",
    "ErrorEvent",
    # Core module
    "Agent",
]