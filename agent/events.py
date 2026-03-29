"""
Event system for agent core - Observer pattern implementation.

This module defines the event types, event dataclasses, and EventEmitter
class for broadcasting state changes, progress updates, thinking status,
and output from the agent.

Event Types:
- AGENT_START: Agent begins running
- AGENT_STOP: Agent stops (completed or cancelled)
- THINKING: Agent is processing/thinking
- TOOL_USE: Agent is using a tool
- OUTPUT: Agent produced output
- ERROR: Agent encountered an error
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Optional
from uuid import uuid4


class AgentEventType(Enum):
    """Enumeration of all agent event types."""
    
    AGENT_START = "agent_start"
    AGENT_STOP = "agent_stop"
    THINKING = "thinking"
    TOOL_USE = "tool_use"
    OUTPUT = "output"
    ERROR = "error"


@dataclass
class AgentEvent:
    """
    Base event dataclass for all agent events.
    
    Attributes:
        timestamp: When the event occurred (UTC)
        event_type: The type of event
        payload: Event-specific data
        id: Unique identifier for this event instance
    """
    
    timestamp: datetime
    event_type: AgentEventType
    payload: Any = None
    id: str = field(default_factory=lambda: str(uuid4())[:8])
    
    def to_dict(self) -> dict:
        """Convert event to dictionary representation."""
        return {
            "id": self.id,
            "timestamp": self.timestamp.isoformat(),
            "event_type": self.event_type.value,
            "payload": self.payload,
        }


@dataclass
class AgentStartEvent(AgentEvent):
    """
    Event emitted when agent starts running.
    
    Payload structure:
    {
        "prompt": str,           # User input prompt
        "model": str,            # Model name being used
        "provider": str,         # Provider name
        "session_id": str | None # Session ID if resuming
    }
    """
    
    event_type: AgentEventType = field(default=AgentEventType.AGENT_START, init=False)


@dataclass
class AgentStopEvent(AgentEvent):
    """
    Event emitted when agent stops.
    
    Payload structure:
    {
        "reason": str,           # "completed" | "cancelled" | "error" | "max_iterations"
        "iterations": int,       # Number of iterations completed
        "response": str | None   # Final response if completed
    }
    """
    
    event_type: AgentEventType = field(default=AgentEventType.AGENT_STOP, init=False)


@dataclass
class ThinkingEvent(AgentEvent):
    """
    Event emitted when agent is thinking/processing.
    
    Payload structure:
    {
        "content": str,          # Thinking content (from <thinking> tags)
        "iteration": int         # Current iteration number
    }
    """
    
    event_type: AgentEventType = field(default=AgentEventType.THINKING, init=False)


@dataclass
class ToolUseEvent(AgentEvent):
    """
    Event emitted when agent uses a tool.
    
    Payload structure:
    {
        "tool_name": str,        # Name of the tool being called
        "arguments": dict,       # Tool arguments
        "iteration": int,        # Current iteration number
        "status": str            # "started" | "completed" | "failed"
    }
    """
    
    event_type: AgentEventType = field(default=AgentEventType.TOOL_USE, init=False)


@dataclass
class OutputEvent(AgentEvent):
    """
    Event emitted when agent produces output.
    
    Payload structure:
    {
        "content": str,          # Output content
        "type": str              # "text" | "tool_result" | "final"
    }
    """
    
    event_type: AgentEventType = field(default=AgentEventType.OUTPUT, init=False)


@dataclass
class ErrorEvent(AgentEvent):
    """
    Event emitted when agent encounters an error.
    
    Payload structure:
    {
        "error": Exception | str,  # The error that occurred
        "message": str,            # Error message
        "iteration": int,          # Iteration where error occurred
        "recoverable": bool        # Whether the error is recoverable
    }
    """
    
    event_type: AgentEventType = field(default=AgentEventType.ERROR, init=False)


# Type alias for event handler functions
EventHandler = Callable[[AgentEvent], None]


class EventEmitter:
    """
    Observer pattern implementation for broadcasting agent events.
    
    Provides subscribe/unsubscribe/emit methods for event-driven
    communication between agent core and listeners.
    
    Usage:
        emitter = EventEmitter()
        
        # Subscribe to specific event types
        def on_output(event):
            print(f"Output: {event.payload}")
        
        emitter.subscribe(AgentEventType.OUTPUT, on_output)
        
        # Subscribe to all events
        def on_any_event(event):
            print(f"Event: {event.event_type.value}")
        
        emitter.subscribe_to_all(on_any_event)
        
        # Emit events
        emitter.emit(AgentEventType.OUTPUT, {"content": "Hello", "type": "text"})
        
        # Unsubscribe
        emitter.unsubscribe(AgentEventType.OUTPUT, on_output)
    """
    
    def __init__(self):
        """Initialize the EventEmitter with empty handler maps."""
        # Map of event type -> list of handlers
        self._handlers: dict[AgentEventType, list[EventHandler]] = {
            event_type: [] for event_type in AgentEventType
        }
        # List of handlers that receive all events
        self._global_handlers: list[EventHandler] = []
    
    def subscribe(self, event_type: AgentEventType, handler: EventHandler) -> None:
        """
        Subscribe to a specific event type.
        
        Args:
            event_type: The type of event to subscribe to
            handler: Function to call when event is emitted
        """
        if event_type not in self._handlers:
            raise ValueError(f"Unknown event type: {event_type}")
        self._handlers[event_type].append(handler)
    
    def unsubscribe(self, event_type: AgentEventType, handler: EventHandler) -> bool:
        """
        Unsubscribe a handler from a specific event type.
        
        Args:
            event_type: The type of event to unsubscribe from
            handler: The handler to remove
            
        Returns:
            True if handler was found and removed, False otherwise
        """
        if event_type not in self._handlers:
            return False
        try:
            self._handlers[event_type].remove(handler)
            return True
        except ValueError:
            return False
    
    def subscribe_to_all(self, handler: EventHandler) -> None:
        """
        Subscribe to all event types.
        
        Args:
            handler: Function to call when any event is emitted
        """
        self._global_handlers.append(handler)
    
    def unsubscribe_from_all(self, handler: EventHandler) -> bool:
        """
        Unsubscribe a handler from all events.
        
        Args:
            handler: The handler to remove from global handlers
            
        Returns:
            True if handler was found and removed, False otherwise
        """
        try:
            self._global_handlers.remove(handler)
            return True
        except ValueError:
            return False
    
    def emit(self, event_type: AgentEventType, payload: Any = None) -> AgentEvent:
        """
        Emit an event to all subscribed handlers.
        
        Creates the appropriate event dataclass based on event_type,
        records the timestamp, and calls all registered handlers.
        
        Args:
            event_type: The type of event to emit
            payload: Event-specific data
            
        Returns:
            The created event object
        """
        timestamp = datetime.now(timezone.utc)
        
        # Create appropriate event class based on type
        event_class_map = {
            AgentEventType.AGENT_START: AgentStartEvent,
            AgentEventType.AGENT_STOP: AgentStopEvent,
            AgentEventType.THINKING: ThinkingEvent,
            AgentEventType.TOOL_USE: ToolUseEvent,
            AgentEventType.OUTPUT: OutputEvent,
            AgentEventType.ERROR: ErrorEvent,
        }
        
        event_class = event_class_map.get(event_type, AgentEvent)
        event = event_class(
            timestamp=timestamp,
            event_type=event_type,
            payload=payload,
        )
        
        # Call handlers for this specific event type
        for handler in self._handlers.get(event_type, []):
            try:
                handler(event)
            except Exception as e:
                # Log error but don't fail the emit
                import sys
                print(f"Event handler error: {e}", file=sys.stderr)
        
        # Call global handlers
        for handler in self._global_handlers:
            try:
                handler(event)
            except Exception as e:
                import sys
                print(f"Global handler error: {e}", file=sys.stderr)
        
        return event
    
    def has_handlers(self, event_type: AgentEventType) -> bool:
        """
        Check if there are handlers registered for an event type.
        
        Args:
            event_type: The type of event to check
            
        Returns:
            True if there are handlers, False otherwise
        """
        return len(self._handlers.get(event_type, [])) > 0 or len(self._global_handlers) > 0
    
    def clear_handlers(self, event_type: Optional[AgentEventType] = None) -> None:
        """
        Clear all handlers for a specific event type or all handlers.
        
        Args:
            event_type: Optional event type to clear. If None, clears all handlers.
        """
        if event_type is None:
            for et in self._handlers:
                self._handlers[et] = []
            self._global_handlers = []
        elif event_type in self._handlers:
            self._handlers[event_type] = []