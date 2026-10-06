graph TD
    A[User Request] --> B{Agent Logic/Planner}
    B -->|Analyze| C[Perception: Understanding Context]
    C -->|Choose Action| D{Tool Use / Capability}
    D -->|Internal Tool| E[Execution: File/Shell/Web]
    E -->|Observe| F[Result/Feedback]
    F -->|Analyze| B
    B -->|Final Answer| G[Response to User]
