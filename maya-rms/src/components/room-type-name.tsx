/**
 * A room type's full name, as the property system has it. Never the short
 * code a PMS keeps beside it, which two different types can share. A long
 * name is cut short on screen with an ellipsis and shown whole on hover.
 * `className` sets how far it may run (a max width) where the parent does not
 * bound it.
 */
export function RoomTypeName({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={`inline-block min-w-0 max-w-full truncate align-bottom ${className}`} title={name}>
      {name}
    </span>
  );
}
