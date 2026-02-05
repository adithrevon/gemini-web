import type { InstanceState } from '../useSession';

interface Project {
  path: string;
  name: string;
  instances: InstanceState[];
}

interface ProjectListProps {
  instances: Map<string, InstanceState>;
  activeInstanceId: string | null;
  onSelectInstance: (instanceId: string) => void;
  onNewChat: (projectPath: string) => void;
  onNewProject: () => void;
}

// Group instances by project path
function groupByProject(instances: Map<string, InstanceState>): Project[] {
  const projectMap = new Map<string, InstanceState[]>();

  for (const instance of instances.values()) {
    const path = instance.projectPath || 'Unknown';
    if (!projectMap.has(path)) {
      projectMap.set(path, []);
    }
    projectMap.get(path)!.push(instance);
  }

  return Array.from(projectMap.entries()).map(([path, insts]) => ({
    path,
    name: path.split('/').pop() || path,
    instances: insts,
  }));
}

export function ProjectList({
  instances,
  activeInstanceId,
  onSelectInstance,
  onNewChat,
  onNewProject,
}: ProjectListProps) {
  const projects = groupByProject(instances);

  return (
    <div className="project-list">
      <h2 className="project-list__title">Chats</h2>

      {projects.length === 0 ? (
        <p className="project-list__empty">No active chats</p>
      ) : (
        <ul className="project-list__projects">
          {projects.map((project) => (
            <li key={project.path} className="project-list__project">
              <div className="project-list__project-header">
                <span
                  className="project-list__project-name"
                  title={project.path}
                >
                  {project.name}
                </span>
                <button
                  className="project-list__new-chat"
                  onClick={() => onNewChat(project.path)}
                  title="New chat in this project"
                >
                  +
                </button>
              </div>
              <ul className="project-list__instances">
                {project.instances.map((instance, index) => (
                  <li key={instance.id}>
                    <button
                      className={`project-list__instance ${
                        instance.id === activeInstanceId
                          ? 'project-list__instance--active'
                          : ''
                      } ${
                        instance.status === 'connected'
                          ? ''
                          : 'project-list__instance--disconnected'
                      }`}
                      onClick={() => onSelectInstance(instance.id)}
                    >
                      <span className="project-list__instance-dot" />
                      <span className="project-list__instance-name">
                        Chat {index + 1}
                      </span>
                      {instance.status !== 'connected' && (
                        <span className="project-list__instance-status">
                          {instance.status}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="project-list__actions">
        <button className="project-list__new-project" onClick={onNewProject}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Project
        </button>
      </div>
    </div>
  );
}
