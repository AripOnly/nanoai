graph TD
    User[User] -->|Input Tugas| Orchestrator[Orchestrator Agent]
    
    subgraph "Execution Layer"
        Orchestrator -->|Delegasi Tugas 1| AgentA[Agent/Worker A]
        Orchestrator -->|Delegasi Tugas 2| AgentB[Agent/Worker B]
        Orchestrator -->|Delegasi Tugas 3| AgentC[Agent/Worker C]
    end
    
    AgentA -->|Hasil| Orchestrator
    AgentB -->|Hasil| Orchestrator
    AgentC -->|Hasil| Orchestrator
    
    Orchestrator -->|Sintesis Hasil| FinalResponse[Final Response]
    FinalResponse -->|Output| User
