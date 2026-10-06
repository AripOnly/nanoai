// src/components/ListSession.jsx

import { useState } from "react";
import { Link } from "react-router-dom";

export default function ListSessions({ listSessions = [] }) {
  const [selected, setSelected] = useState(null);

  return (
    <>
      <div className="pl-2 py-1 mt-2">
        <p className="text-lg font-medium">Sessions</p>
      </div>

      <div className="px-2">
        <ul>
          {listSessions.map((value, index) => {
            return (
              <li
                key={index}
                onClick={() => setSelected(index)}
                className={
                  selected === index
                    ? "px-2 py-0.5 hover:bg-gray-200 rounded-sm bg-gray-200"
                    : "px-2 py-0.5 hover:bg-gray-200 rounded-sm"
                }
              >
                <Link to={`/c/${value.id}`} className="inline-block w-full">
                  {value.name}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
