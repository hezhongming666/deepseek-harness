using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpennessBridge
{
    /// <summary>
    /// The bridge's HTTP JSON wire: request/response DTOs and the shared
    /// serialization options. Field names follow the protocol's camelCase
    /// names; parameters travel as lossless-JSON elements.
    /// </summary>
    internal static class Wire
    {
        public static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        public sealed class ValidateRequest
        {
            public Dictionary<string, JsonElement> Params { get; set; } = new Dictionary<string, JsonElement>();
        }

        public sealed class RunRequest
        {
            public string RunId { get; set; } = string.Empty;
            public Dictionary<string, JsonElement> Params { get; set; } = new Dictionary<string, JsonElement>();
        }

        public sealed class CancelRequest
        {
            public string RunId { get; set; } = string.Empty;
        }

        public sealed class HealthResponse
        {
            public bool Ok { get; set; }
            public Dictionary<string, string>? Environment { get; set; }
            public string? Error { get; set; }
        }

        public sealed class ValidateResponse
        {
            public bool Ok { get; set; }
            public List<string> Reasons { get; set; } = new List<string>();
        }

        public sealed class RunResponse
        {
            public string RunId { get; set; } = string.Empty;
            public string Status { get; set; } = string.Empty;
            public Dictionary<string, JsonElement>? Result { get; set; }
            public double? LicenseMs { get; set; }
            public string? Error { get; set; }
            public Dictionary<string, string>? Environment { get; set; }
        }

        public sealed class ErrorResponse
        {
            public string Error { get; set; } = string.Empty;
        }
    }
}
