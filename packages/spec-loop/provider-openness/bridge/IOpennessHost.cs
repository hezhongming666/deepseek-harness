using System;
using System.Collections.Generic;
using System.Text.Json;

namespace OpennessBridge
{
    /// <summary>
    /// Thrown when the bridge cannot reach or operate its backing host
    /// (TIA Portal, the project, or the compile infrastructure). The server
    /// maps it to HTTP 503 so the adapter classifies the call as S3.
    /// </summary>
    public sealed class InfrastructureException : Exception
    {
        public InfrastructureException(string message)
            : base(message)
        {
        }

        public InfrastructureException(string message, Exception inner)
            : base(message, inner)
        {
        }
    }

    /// <summary>
    /// The backing host behind the protocol server: validate is the cheap
    /// S1 gate, run executes one candidate, and health reports readiness.
    /// The fake implementation is deterministic; the Openness implementation
    /// drives TIA Portal.
    /// </summary>
    internal interface IOpennessHost : IDisposable
    {
        /// <summary>Readiness plus the environment tuple; never throws.</summary>
        Wire.HealthResponse Health();

        /// <summary>
        /// Reject infeasible parameters without consuming license or resources.
        /// </summary>
        /// <param name="parameters">The candidate parameter set.</param>
        /// <returns>The S1-gate outcome.</returns>
        /// <exception cref="InfrastructureException">The backing host is unavailable.</exception>
        Wire.ValidateResponse Validate(IReadOnlyDictionary<string, JsonElement> parameters);

        /// <summary>
        /// Execute one candidate and return the structured outcome.
        /// </summary>
        /// <param name="runId">The adapter's correlation id.</param>
        /// <param name="parameters">The candidate parameter set.</param>
        /// <param name="action">Per-request action override; the config's action applies when null.</param>
        /// <param name="blockName">The `verify` action's target block name.</param>
        /// <param name="source">The `verify` action's SCL source text.</param>
        /// <param name="cancelled">True when the adapter cancelled this run.</param>
        /// <returns>The run outcome; `killed` when cancelled.</returns>
        /// <exception cref="InfrastructureException">The backing host is unavailable.</exception>
        Wire.RunResponse Run(
            string runId,
            IReadOnlyDictionary<string, JsonElement> parameters,
            string? action,
            string? blockName,
            string? source,
            Func<bool> cancelled);
    }
}
