"""
Unit tests for the agent event system.

Tests verify:
1. EventEmitter subscribe/unsubscribe/emit methods
2. Event dataclasses for each event type
3. Agent core emits events at correct points
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.events import (
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
from agent.core import Agent, AgentState


class TestEventEmitter:
    """Tests for EventEmitter class."""
    
    def test_create_event_emitter(self):
        """EventEmitter can be created."""
        emitter = EventEmitter()
        assert emitter is not None
        assert len(emitter._handlers) == len(AgentEventType)
        assert len(emitter._global_handlers) == 0
    
    def test_subscribe_to_event(self):
        """Can subscribe to a specific event type."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        emitter.subscribe(AgentEventType.OUTPUT, handler)
        
        assert handler in emitter._handlers[AgentEventType.OUTPUT]
    
    def test_subscribe_multiple_handlers(self):
        """Can have multiple handlers for same event type."""
        emitter = EventEmitter()
        handler1 = MagicMock()
        handler2 = MagicMock()
        
        emitter.subscribe(AgentEventType.OUTPUT, handler1)
        emitter.subscribe(AgentEventType.OUTPUT, handler2)
        
        assert len(emitter._handlers[AgentEventType.OUTPUT]) == 2
    
    def test_subscribe_invalid_event_type_raises(self):
        """Subscribing to invalid event type raises ValueError."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        with pytest.raises(ValueError):
            emitter.subscribe("invalid_event", handler)  # type: ignore
    
    def test_unsubscribe_handler(self):
        """Can unsubscribe a handler."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        emitter.subscribe(AgentEventType.OUTPUT, handler)
        result = emitter.unsubscribe(AgentEventType.OUTPUT, handler)
        
        assert result is True
        assert handler not in emitter._handlers[AgentEventType.OUTPUT]
    
    def test_unsubscribe_nonexistent_handler(self):
        """Unsubscribing nonexistent handler returns False."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        result = emitter.unsubscribe(AgentEventType.OUTPUT, handler)
        
        assert result is False
    
    def test_subscribe_to_all(self):
        """Can subscribe to all events."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        emitter.subscribe_to_all(handler)
        
        assert handler in emitter._global_handlers
    
    def test_unsubscribe_from_all(self):
        """Can unsubscribe from all events."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        emitter.subscribe_to_all(handler)
        result = emitter.unsubscribe_from_all(handler)
        
        assert result is True
        assert handler not in emitter._global_handlers
    
    def test_emit_calls_handlers(self):
        """Emit calls all registered handlers for event type."""
        emitter = EventEmitter()
        handler1 = MagicMock()
        handler2 = MagicMock()
        
        emitter.subscribe(AgentEventType.OUTPUT, handler1)
        emitter.subscribe(AgentEventType.OUTPUT, handler2)
        
        event = emitter.emit(AgentEventType.OUTPUT, {"content": "test"})
        
        handler1.assert_called_once_with(event)
        handler2.assert_called_once_with(event)
    
    def test_emit_calls_global_handlers(self):
        """Emit calls global handlers for all event types."""
        emitter = EventEmitter()
        global_handler = MagicMock()
        
        emitter.subscribe_to_all(global_handler)
        
        event = emitter.emit(AgentEventType.OUTPUT, {"content": "test"})
        
        global_handler.assert_called_once_with(event)
    
    def test_emit_creates_correct_event_type(self):
        """Emit creates the correct event class based on type."""
        emitter = EventEmitter()
        
        start_event = emitter.emit(AgentEventType.AGENT_START, {"prompt": "test"})
        stop_event = emitter.emit(AgentEventType.AGENT_STOP, {"reason": "completed"})
        thinking_event = emitter.emit(AgentEventType.THINKING, {"content": "thinking"})
        tool_event = emitter.emit(AgentEventType.TOOL_USE, {"tool_name": "test"})
        output_event = emitter.emit(AgentEventType.OUTPUT, {"content": "test"})
        error_event = emitter.emit(AgentEventType.ERROR, {"message": "test"})
        
        assert isinstance(start_event, AgentStartEvent)
        assert isinstance(stop_event, AgentStopEvent)
        assert isinstance(thinking_event, ThinkingEvent)
        assert isinstance(tool_event, ToolUseEvent)
        assert isinstance(output_event, OutputEvent)
        assert isinstance(error_event, ErrorEvent)
    
    def test_emit_continues_after_handler_error(self):
        """Emit continues even if a handler throws an error."""
        emitter = EventEmitter()
        failing_handler = MagicMock(side_effect=RuntimeError("Handler error"))
        good_handler = MagicMock()
        
        emitter.subscribe(AgentEventType.OUTPUT, failing_handler)
        emitter.subscribe(AgentEventType.OUTPUT, good_handler)
        
        # Should not raise
        event = emitter.emit(AgentEventType.OUTPUT, {"content": "test"})
        
        # Both handlers should be called
        failing_handler.assert_called_once()
        good_handler.assert_called_once()
    
    def test_has_handlers(self):
        """has_handlers returns correct status."""
        emitter = EventEmitter()
        handler = MagicMock()
        
        assert not emitter.has_handlers(AgentEventType.OUTPUT)
        
        emitter.subscribe(AgentEventType.OUTPUT, handler)
        assert emitter.has_handlers(AgentEventType.OUTPUT)
    
    def test_has_handlers_with_global(self):
        """has_handlers returns True if global handlers exist."""
        emitter = EventEmitter()
        
        assert not emitter.has_handlers(AgentEventType.OUTPUT)
        
        emitter.subscribe_to_all(MagicMock())
        assert emitter.has_handlers(AgentEventType.OUTPUT)
    
    def test_clear_handlers_specific(self):
        """clear_handlers clears handlers for specific event type."""
        emitter = EventEmitter()
        handler1 = MagicMock()
        handler2 = MagicMock()
        
        emitter.subscribe(AgentEventType.OUTPUT, handler1)
        emitter.subscribe(AgentEventType.THINKING, handler2)
        
        emitter.clear_handlers(AgentEventType.OUTPUT)
        
        assert len(emitter._handlers[AgentEventType.OUTPUT]) == 0
        assert len(emitter._handlers[AgentEventType.THINKING]) == 1
    
    def test_clear_handlers_all(self):
        """clear_handlers with None clears all handlers."""
        emitter = EventEmitter()
        
        emitter.subscribe(AgentEventType.OUTPUT, MagicMock())
        emitter.subscribe(AgentEventType.THINKING, MagicMock())
        emitter.subscribe_to_all(MagicMock())
        
        emitter.clear_handlers()
        
        for event_type in AgentEventType:
            assert len(emitter._handlers[event_type]) == 0
        assert len(emitter._global_handlers) == 0


class TestEventDataclasses:
    """Tests for event dataclasses."""
    
    def test_agent_event_base(self):
        """AgentEvent base class has required fields."""
        event = AgentEvent(
            timestamp=datetime.now(timezone.utc),
            event_type=AgentEventType.OUTPUT,
            payload={"content": "test"},
        )
        
        assert event.timestamp is not None
        assert event.event_type == AgentEventType.OUTPUT
        assert event.payload == {"content": "test"}
        assert event.id is not None
    
    def test_agent_event_to_dict(self):
        """AgentEvent.to_dict returns correct structure."""
        timestamp = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        event = AgentEvent(
            timestamp=timestamp,
            event_type=AgentEventType.OUTPUT,
            payload={"content": "test"},
            id="test-id",
        )
        
        result = event.to_dict()
        
        assert result["id"] == "test-id"
        assert result["timestamp"] == "2024-01-01T12:00:00+00:00"
        assert result["event_type"] == "output"
        assert result["payload"] == {"content": "test"}
    
    def test_agent_start_event(self):
        """AgentStartEvent has correct default event_type."""
        event = AgentStartEvent(
            timestamp=datetime.now(timezone.utc),
            payload={"prompt": "test"},
        )
        
        assert event.event_type == AgentEventType.AGENT_START
    
    def test_agent_stop_event(self):
        """AgentStopEvent has correct default event_type."""
        event = AgentStopEvent(
            timestamp=datetime.now(timezone.utc),
            payload={"reason": "completed"},
        )
        
        assert event.event_type == AgentEventType.AGENT_STOP
    
    def test_thinking_event(self):
        """ThinkingEvent has correct default event_type."""
        event = ThinkingEvent(
            timestamp=datetime.now(timezone.utc),
            payload={"content": "thinking..."},
        )
        
        assert event.event_type == AgentEventType.THINKING
    
    def test_tool_use_event(self):
        """ToolUseEvent has correct default event_type."""
        event = ToolUseEvent(
            timestamp=datetime.now(timezone.utc),
            payload={"tool_name": "read_file"},
        )
        
        assert event.event_type == AgentEventType.TOOL_USE
    
    def test_output_event(self):
        """OutputEvent has correct default event_type."""
        event = OutputEvent(
            timestamp=datetime.now(timezone.utc),
            payload={"content": "output"},
        )
        
        assert event.event_type == AgentEventType.OUTPUT
    
    def test_error_event(self):
        """ErrorEvent has correct default event_type."""
        event = ErrorEvent(
            timestamp=datetime.now(timezone.utc),
            payload={"message": "error"},
        )
        
        assert event.event_type == AgentEventType.ERROR


class TestAgentEvents:
    """Tests for Agent event emission."""
    
    def test_agent_has_event_emitter(self):
        """Agent has an EventEmitter."""
        agent = Agent()
        
        assert hasattr(agent, 'events')
        assert isinstance(agent.events, EventEmitter)
    
    def test_agent_initial_state(self):
        """Agent starts in IDLE state."""
        agent = Agent()
        
        assert agent.state == AgentState.IDLE
        assert agent.iteration == 0
        assert len(agent.messages) == 0
    
    def test_agent_start_emits_event(self):
        """Agent.start() emits AGENT_START event."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.AGENT_START, handler)
        
        agent.start("test prompt")
        
        assert agent.state == AgentState.RUNNING
        handler.assert_called_once()
        event = handler.call_args[0][0]
        assert isinstance(event, AgentStartEvent)
        assert event.payload["prompt"] == "test prompt"
    
    def test_agent_start_with_session_id(self):
        """Agent.start() includes session_id in event payload."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.AGENT_START, handler)
        
        agent.start("test prompt", session_id="test-session")
        
        event = handler.call_args[0][0]
        assert event.payload["session_id"] == "test-session"
    
    def test_agent_start_adds_message(self):
        """Agent.start() adds user message to conversation."""
        agent = Agent()
        
        agent.start("test prompt")
        
        assert len(agent.messages) == 1
        assert agent.messages[0]["role"] == "user"
        assert agent.messages[0]["content"] == "test prompt"
    
    def test_agent_stop_emits_event(self):
        """Agent.stop() emits AGENT_STOP event."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.AGENT_STOP, handler)
        
        agent.start("test")
        agent.stop(reason="completed", response="done")
        
        handler.assert_called_once()
        event = handler.call_args[0][0]
        assert isinstance(event, AgentStopEvent)
        assert event.payload["reason"] == "completed"
        assert event.payload["response"] == "done"
    
    def test_agent_stop_sets_state(self):
        """Agent.stop() sets correct state based on reason."""
        agent = Agent()
        
        agent.start("test")
        agent.stop(reason="completed")
        
        assert agent.state == AgentState.STOPPED
        
        agent.reset()
        agent.start("test")
        agent.stop(reason="cancelled")
        
        assert agent.state == AgentState.CANCELLED
    
    def test_agent_think_emits_event(self):
        """Agent.think() emits THINKING event."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.THINKING, handler)
        
        agent.think("processing...")
        
        handler.assert_called_once()
        event = handler.call_args[0][0]
        assert isinstance(event, ThinkingEvent)
        assert event.payload["content"] == "processing..."
    
    def test_agent_use_tool_emits_event(self):
        """Agent.use_tool() emits TOOL_USE event."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.TOOL_USE, handler)
        
        agent.use_tool("read_file", {"path": "/test"}, status="started")
        
        handler.assert_called_once()
        event = handler.call_args[0][0]
        assert isinstance(event, ToolUseEvent)
        assert event.payload["tool_name"] == "read_file"
        assert event.payload["arguments"] == {"path": "/test"}
        assert event.payload["status"] == "started"
    
    def test_agent_output_emits_event(self):
        """Agent.output() emits OUTPUT event."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.OUTPUT, handler)
        
        agent.output("result", output_type="text")
        
        handler.assert_called_once()
        event = handler.call_args[0][0]
        assert isinstance(event, OutputEvent)
        assert event.payload["content"] == "result"
        assert event.payload["type"] == "text"
    
    def test_agent_error_emits_event(self):
        """Agent.error() emits ERROR event."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.ERROR, handler)
        
        test_error = ValueError("test error")
        agent.error(test_error, "test error message", recoverable=True)
        
        handler.assert_called_once()
        event = handler.call_args[0][0]
        assert isinstance(event, ErrorEvent)
        assert event.payload["error"] == test_error
        assert event.payload["message"] == "test error message"
        assert event.payload["recoverable"] is True
    
    def test_agent_reset(self):
        """Agent.reset() clears state."""
        agent = Agent()
        
        agent.start("test")
        agent.iteration = 5
        agent.messages.append({"role": "assistant", "content": "test"})
        
        agent.reset()
        
        assert agent.state == AgentState.IDLE
        assert agent.iteration == 0
        assert len(agent.messages) == 0
    
    def test_agent_cancel(self):
        """Agent.cancel() sets cancel flag."""
        agent = Agent()
        
        agent.cancel()
        
        assert agent._cancel_requested is True
    
    @pytest.mark.asyncio
    async def test_agent_run_emits_start_and_stop(self):
        """Agent.run() emits AGENT_START and AGENT_STOP events."""
        agent = Agent()
        start_handler = MagicMock()
        stop_handler = MagicMock()
        agent.events.subscribe(AgentEventType.AGENT_START, start_handler)
        agent.events.subscribe(AgentEventType.AGENT_STOP, stop_handler)
        
        await agent.run("test prompt")
        
        start_handler.assert_called_once()
        stop_handler.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_agent_run_emits_thinking(self):
        """Agent.run() emits THINKING event during loop."""
        agent = Agent()
        handler = MagicMock()
        agent.events.subscribe(AgentEventType.THINKING, handler)
        
        await agent.run("test prompt")
        
        handler.assert_called()
    
    @pytest.mark.asyncio
    async def test_agent_run_stops_on_max_iterations(self):
        """Agent.run() stops after max_iterations."""
        agent = Agent(max_iterations=2)
        stop_handler = MagicMock()
        agent.events.subscribe(AgentEventType.AGENT_STOP, stop_handler)
        
        await agent.run("test prompt")
        
        # Verify max_iterations was respected
        assert agent.iteration <= agent.max_iterations
    
    def test_create_agent_factory(self):
        """create_agent factory creates configured Agent."""
        from agent.core import create_agent
        
        agent = create_agent(model="test-model", max_iterations=10)
        
        assert agent.model == "test-model"
        assert agent.max_iterations == 10


class TestEventOrdering:
    """Tests for event ordering and sequencing."""
    
    def test_events_emitted_in_order(self):
        """Events are emitted in the order they occur."""
        agent = Agent()
        events = []
        
        def capture(event):
            events.append(event.event_type.value)
        
        agent.events.subscribe_to_all(capture)
        
        agent.start("test")
        agent.think("thinking")
        agent.output("output")
        agent.stop(reason="completed")
        
        assert events == [
            "agent_start",
            "thinking",
            "output",
            "agent_stop",
        ]
    
    def test_multiple_subscribers_same_event(self):
        """Multiple subscribers all receive the same event."""
        emitter = EventEmitter()
        events1 = []
        events2 = []
        
        def capture1(event):
            events1.append(event)
        
        def capture2(event):
            events2.append(event)
        
        emitter.subscribe(AgentEventType.OUTPUT, capture1)
        emitter.subscribe(AgentEventType.OUTPUT, capture2)
        
        emitted = emitter.emit(AgentEventType.OUTPUT, {"content": "test"})
        
        assert len(events1) == 1
        assert len(events2) == 1
        assert events1[0] is emitted
        assert events2[0] is emitted


if __name__ == "__main__":
    pytest.main([__file__, "-v"])