graph TD
    A[User] -->|Interaksi| B(React Application)
    B --> C{Komponen}
    C -->|Menggunakan| D[JSX]
    C -->|Mengelola| E[State & Props]
    E -->|Mengupdate| F[Virtual DOM]
    F -->|Sinkronisasi| G[Browser DOM]
    G -->|Tampil ke| A
