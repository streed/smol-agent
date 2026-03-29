"""
Agent core module - Main agent loop with event emission.

This module implements the Agent class that drives the conversation
with an LLM provider. It emits events at key points in the lifecycle:

- AGENT_START: When the agent begins running
- AGENT_STOP: When the agent stops (completed, cancelled, error)
- THINKING: When the agent is processing/thinking
- TOOL_USE: When the agent uses a tool
- OUTPUT: When the agent produces output
- ERROR: When the agent encounters an error

The agent follows an event-driven architecture that allows external
systems to observe state changes and progress without tight coupling.
"""

from typing import Any, Optional
from .events import (
    EventEmitter,
    AgentEventType,
    AgentStartEvent,
    AgentStopEvent,
    ThinkingEvent,
    ToolUseEvent,
    OutputEvent,
    ErrorEvent,
)


class AgentState:
    """Enumeration of agent states."""
    IDLE = "idle"
    RUNNING = "running"
    STOPPED = "stopped"
    CANCELLED = "cancelled"
    ERROR = "error"


class Agent:
    """
    Core agent class that drives conversations with an LLM provider.
    
    Emits events at key points in the lifecycle for observers to react to
    state changes, progress updates, thinking status, and output.
    
    Usage:
        agent = Agent(llm_provider=my_provider)
        
        # Subscribe to events
        def on_output(event):
            print(event.payload["content"])
        
        agent.events.subscribe(AgentEventType.OUTPUT, on_output)
        
        # Run the agent
        result = await agent.run("Write a hello world program")
        
        # Or use context manager for automatic cleanup
        async with agent.session("Write code") as session:
            result = session.result
    
    Attributes:
        events: EventEmitter instance for subscribing to events
        state: Current agent state (idle, running, stopped, etc.)
        messages: List of conversation messages
        iteration: Current iteration count
        max_iterations: Maximum allowed iterations
    """
    
    # Default maximum iterations
    DEFAULT_MAX_ITERATIONS = 25
    
    def __init__(
        self,
        llm_provider: Optional[Any] = None,
        *,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        host: Optional[str] = None,
        api_key: Optional[str] = None,
        max_iterations: int = DEFAULT_MAX_ITERATIONS,
        context: Optional[str] = None,
        tools: Optional[list] = None,
    ):
        """
        Initialize the Agent.
        
        Args:
            llm_provider: Pre-built LLM provider instance (optional)
            model: Model name to use
            provider: Provider name (ollama, openai, anthropic, etc.)
            host: API host URL
            api_key: API key for cloud providers
            max_iterations: Maximum iterations per run
            context: Project context string
            tools: List of tools available to the agent
        """
        self.llm_provider = llm_provider
        self.model = model
        self.provider = provider
        self.host = host
        self.api_key = api_key
        self.max_iterations = max_iterations
        self.context = context
        self.tools = tools or []
        
        # Event system
        self.events = EventEmitter()
        
        # State
        self.state = AgentState.IDLE
        self.messages: list[dict] = []
        self.iteration = 0
        self._cancel_requested = False
    
    def _emit(self, event_type: AgentEventType, payload: Any = None) -> None:
        """
        Helper to emit an event.
        
        Args:
            event_type: Type of event to emit
            payload: Event payload data
        """
        self.events.emit(event_type, payload)
    
    def start(self, prompt: str, session_id: Optional[str] = None) -> None:
        """
        Start the agent with a prompt.
        
        Emits AGENT_START event.
        
        Args:
            prompt: User input prompt
            session_id: Optional session ID if resuming
        """
        self.state = AgentState.RUNNING
        self._cancel_requested = False
        self.iteration = 0
        
        self._emit(AgentEventType.AGENT_START, {
            "prompt": prompt,
            "model": self.model or "default",
            "provider": self.provider or "ollama",
            "session_id": session_id,
        })
        
        # Add user message to conversation
        self.messages.append({"role": "user", "content": prompt})
    
    def stop(self, reason: str = "completed", response: Optional[str] = None) -> None:
        """
        Stop the agent.
        
        Emits AGENT_STOP event.
        
        Args:
            reason: Stop reason ("completed", "cancelled", "error", "max_iterations")
            response: Final response if completed
        """
        previous_state = self.state
        self.state = AgentState.STOPPED if reason == "completed" else AgentState.CANCELLED
        
        self._emit(AgentEventType.AGENT_STOP, {
            "reason": reason,
            "iterations": self.iteration,
            "response": response,
        })
    
    def cancel(self) -> None:
        """Request agent cancellation."""
        self._cancel_requested = True
    
    def think(self, content: str) -> None:
        """
        Emit a thinking event with content.
        
        Args:
            content: Thinking content (e.g., from <thinking> tags)
        """
        self._emit(AgentEventType.THINKING, {
            "content": content,
            "iteration": self.iteration,
        })
    
    def use_tool(
        self,
        tool_name: str,
        arguments: dict,
        status: str = "started",
    ) -> None:
        """
        Emit a tool use event.
        
        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            status: Tool status ("started", "completed", "failed")
        """
        self._emit(AgentEventType.TOOL_USE, {
            "tool_name": tool_name,
            "arguments": arguments,
            "iteration": self.iteration,
            "status": status,
        })
    
    def output(self, content: str, output_type: str = "text") -> None:
        """
        Emit an output event.
        
        Args:
            content: Output content
            output_type: Type of output ("text", "tool_result", "final")
        """
        self._emit(AgentEventType.OUTPUT, {
            "content": content,
            "type": output_type,
        })
    
    def error(
        self,
        error: Exception | str,
        message: str,
        recoverable: bool = False,
    ) -> None:
        """
        Emit an error event.
        
        Args:
            error: The error that occurred
            message: Error message
            recoverable: Whether the error is recoverable
        """
        self._emit(AgentEventType.ERROR, {
            "error": error,
            "message": message,
            "iteration": self.iteration,
            "recoverable": recoverable,
        })
    
    async def run(self, prompt: str, session_id: Optional[str] = None) -> str:
        """
        Run the agent with a prompt.
        
        This is the main entry point for agent execution. It:
        1. Emits AGENT_START
        2. Runs the agent loop up to max_iterations
        3. Emits THINKING, TOOL_USE, OUTPUT events during execution
        4. Emits ERROR events for any errors
        5. Emits AGENT_STOP when done
        
        Args:
            prompt: User input prompt
            session_id: Optional session ID if resuming
            
        Returns:
            Final response from the agent
        """
        self.start(prompt, session_id)
        
        try:
            response = await self._run_loop()
            self.stop(reason="completed", response=response)
            return response
        except Exception as e:
            self.error(e, str(e), recoverable=False)
            self.stop(reason="error")
            raise
        finally:
            if self._cancel_requested:
                self.stop(reason="cancelled")
    
    async def _run_loop(self) -> str:
        """
        Internal: Run the agent loop.
        
        Override this method to implement the actual agent logic.
        
        Returns:
            Final response string
        """
        # This is a simplified implementation
        # In a real agent, this would:
        # 1. Call LLM provider with messages
        # 2. Parse response for tool calls
        # 3. Execute tools
        # 4. Feed results back
        # 5. Repeat until no more tool calls
        
        while self.iteration < self.max_iterations and not self._cancel_requested:
            self.iteration += 1
            
            # Emit thinking event at start of iteration
            self.think(f"Starting iteration {self.iteration}")
            
            # Placeholder: In real implementation, call LLM here
            # For now, just emit output and break
            self.output("Agent execution placeholder", output_type="text")
            break
        
        if self.iteration >= self.max_iterations:
            self.stop(reason="max_iterations")
        
        return "Agent execution complete"
    
    def reset(self) -> None:
        """Reset the agent to initial state."""
        self.state = AgentState.IDLE
        self.messages = []
        self.iteration = 0
        self._cancel_requested = False


def create_agent(**kwargs) -> Agent:
    """
    Factory function to create an Agent instance.
    
    Args:
        **kwargs: Arguments passed to Agent constructor
        
    Returns:
        Configured Agent instance
    """
    return Agent(**kwargs)